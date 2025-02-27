/* eslint-env jquery */
const Apify = require('apify');
const querystring = require('querystring');

const Puppeteer = require('puppeteer'); // eslint-disable-line
const typedefs = require('./typedefs'); // eslint-disable-line no-unused-vars
const Stats = require('./helper-classes/stats'); // eslint-disable-line no-unused-vars
const PlacesCache = require('./helper-classes/places_cache'); // eslint-disable-line no-unused-vars
const MaxCrawledPlacesTracker = require('./helper-classes/max-crawled-places'); // eslint-disable-line no-unused-vars
const ExportUrlsDeduper = require('./helper-classes/export-urls-deduper'); // eslint-disable-line no-unused-vars

const { sleep, log } = Apify.utils;
const { MAX_PLACES_PER_PAGE, PLACE_TITLE_SEL, NO_RESULT_XPATH } = require('./consts');
const { waitForGoogleMapLoader, parseZoomFromUrl, moveMouseThroughPage, getScreenshotPinsFromExternalActor } = require('./utils/misc-utils');
const { parseSearchPlacesResponseBody } = require('./place-extractors/general');
const { checkInPolygon } = require('./utils/polygon');

const SEARCH_WAIT_TIME_MS = 30000;
const CHECK_LOAD_OUTCOMES_EVERY_MS = 500;

/**
 * This handler waiting for response from xhr and enqueue places from the search response boddy.
 * @param {{
 *   page: Puppeteer.Page,
 *   requestQueue: Apify.RequestQueue,
 *   request: Apify.Request,
 *   searchString: string,
 *   exportPlaceUrls: boolean,
 *   geolocation: typedefs.Geolocation | undefined,
 *   placesCache: PlacesCache,
 *   stats: Stats,
 *   maxCrawledPlacesTracker: MaxCrawledPlacesTracker,
 *   exportUrlsDeduper: ExportUrlsDeduper | undefined,
 *   crawler: Apify.PuppeteerCrawler,
 * }} options
 * @return {(response: Puppeteer.HTTPResponse, pageStats: typedefs.PageStats) => Promise<any>}
 */
const enqueuePlacesFromResponse = (options) => {
    const { page, requestQueue, searchString, request, exportPlaceUrls, geolocation,
        placesCache, stats, maxCrawledPlacesTracker, exportUrlsDeduper, crawler } = options;
    return async (response, pageStats) => {
        const url = response.url();
        const isSearchPage = url.match(/google\.[a-z.]+\/search/);
        const isDetailPreviewPage = !!url.match(/google\.[a-z.]+\/maps\/preview\/place/);
        if (!isSearchPage && !isDetailPreviewPage) {
            return;
        }

        let responseBody;
        let responseStatus;

        pageStats.isDataPage = true;

        try {
            responseStatus = response.status();
            if (responseStatus !== 200) {
                log.warning(`Response status is not 200, it is ${responseStatus}. This might mean the response is blocked`);
            }
            responseBody = await response.text();
            const { placesPaginationData, error } = parseSearchPlacesResponseBody(responseBody, isDetailPreviewPage);
            if (error) {
                // This way we pass the error to the synchronous context where we can throw to retry
                pageStats.error = { message: error, responseStatus, responseBody };
            }
            let index = -1;
            // At this point, page URL should be resolved
            const searchPageUrl = page.url();

            // Parse page number from request url
            const queryParams = querystring.parse(url.split('?')[1]);
            // @ts-ignore
            const pageNumber = parseInt(queryParams.ech, 10);

            // Cleanup for this page
            pageStats.enqueued = 0;
            pageStats.pushed = 0;

            pageStats.totalFound += placesPaginationData.length;
            pageStats.found = placesPaginationData.length;
            for (const placePaginationData of placesPaginationData) {
                index++;
                const rank = ((pageNumber - 1) * 20) + (index + 1);
                // TODO: Refactor this once we get rid of the caching
                const coordinates = placePaginationData.coords || placesCache.getLocation(placePaginationData.placeId);
                const placeUrl = `https://www.google.com/maps/search/?api=1&query=${searchString}&query_place_id=${placePaginationData.placeId}`;
                placesCache.addLocation(placePaginationData.placeId, coordinates, searchString);

                // true if no geo or coordinates
                const isCorrectGeolocation = checkInPolygon(geolocation, coordinates);
                if (!isCorrectGeolocation) {
                    stats.outOfPolygonCached();
                    stats.outOfPolygon();
                    stats.addOutOfPolygonPlace({ url: placeUrl, searchPageUrl, coordinates });
                    continue;
                }
                if (exportPlaceUrls) {
                    if (!maxCrawledPlacesTracker.canScrapeMore()) {
                        break;
                    }

                    const wasAlreadyPushed = exportUrlsDeduper?.testDuplicateAndAdd(placePaginationData.placeId);
                    let shouldScrapeMore = true;
                    if (!wasAlreadyPushed) {
                        shouldScrapeMore = maxCrawledPlacesTracker.setScraped();
                        pageStats.pushed++;
                        pageStats.totalPushed++;
                        await Apify.pushData({
                            url: `https://www.google.com/maps/search/?api=1&query=${searchString}&query_place_id=${placePaginationData.placeId}`,
                        });
                    }
                    if (!shouldScrapeMore) {
                        log.warning(`[SEARCH]: Finishing scraping because we reached maxCrawledPlaces `
                            // + `currently: ${maxCrawledPlacesTracker.enqueuedPerSearch[searchKey]}(for this search)/${maxCrawledPlacesTracker.enqueuedTotal}(total) `
                            + `--- ${searchString} - ${request.url}`);
                        // We need to wait a bit so the pages got processed and data pushed
                        await page.waitForTimeout(5000);
                        await crawler.autoscaledPool?.abort();
                        break;
                    }
                } else {
                    const searchKey = searchString || request.url;
                    if (!maxCrawledPlacesTracker.setEnqueued(searchKey)) {
                        log.warning(`[SEARCH]: Finishing search because we enqueued more than maxCrawledPlaces `
                            + `currently: ${maxCrawledPlacesTracker.enqueuedPerSearch[searchKey]}(for this search)/${maxCrawledPlacesTracker.enqueuedTotal}(total) `
                            + `--- ${searchString} - ${request.url}`);
                        break;
                    }
                    const { wasAlreadyPresent } = await requestQueue.addRequest({
                            url: placeUrl,
                            uniqueKey: placePaginationData.placeId,
                            userData: {
                                label: 'detail',
                                searchString,
                                rank,
                                searchPageUrl,
                                coords: placePaginationData.coords,
                                addressParsed: placePaginationData.addressParsed,
                                isAdvertisement: placePaginationData.isAdvertisement,
                                categories: placePaginationData.categories
                            },
                        },
                        { forefront: true });
                    if (!wasAlreadyPresent) {
                        pageStats.enqueued++;
                        pageStats.totalEnqueued++;
                    } else {
                        // log.warning(`Google presented already enqueued place, skipping... --- ${placeUrl}`)
                        maxCrawledPlacesTracker.enqueuedTotal--;
                        maxCrawledPlacesTracker.enqueuedPerSearch[searchKey]--;
                    }
                }
            }
            const numberOfAds = placesPaginationData.filter((item) => item.isAdvertisement).length;
            // Detail preview page goes one by one so should be logged after
            if (isSearchPage) {
                const typeOfResultAction = exportPlaceUrls ? 'Pushed' : 'Enqueued';
                const typeOfResultsCount = exportPlaceUrls ? pageStats.pushed : pageStats.enqueued;
                const typeOfResultsCountTotal = exportPlaceUrls ? pageStats.totalPushed : pageStats.totalEnqueued;
                log.info(`[SEARCH][${searchString}][SCROLL: ${pageStats.pageNum}]: ${typeOfResultAction} ${typeOfResultsCount}/${pageStats.found} `
                    + `places (unique & correct/found) + ${numberOfAds} ads `
                    + `for this page. Total for this search: ${typeOfResultsCountTotal}/${pageStats.totalFound}  --- ${page.url()}`)
            }
        } catch (e) {
            const error = /** @type {Error} */ (e);
            const message = `Unexpected error during response processing: ${error.message}`;
            pageStats.error = { message, responseStatus, responseBody };
        }
    };
};


/**
 * Periodically checks if one of the possible search outcomes have happened
 * @param {Puppeteer.Page} page
 * @returns {Promise<typedefs.SearchResultOutcome>} // Typing this would require to list all props all time
 */
const waitForSearchResults = async (page) => {
    const start = Date.now();
    // All possible outcomes should be unique, when outcomes happens, we return it
    for (;;) {
        if (Date.now() - start > SEARCH_WAIT_TIME_MS) {
            return { noOutcomeLoaded: true };
        }
        // These must be contains checks because Google sometimes puts an ID into the selector
        const isBadQuery = await page.$('[class *= "section-bad-query"');
        if (isBadQuery) {
            return { isBadQuery: true };
        }

        const hasNoResults = await page.$x(NO_RESULT_XPATH);
        if (hasNoResults.length > 0) {
            return { hasNoResults: true };
        }

        const isPlaceDetail = await page.$(PLACE_TITLE_SEL);
        if (isPlaceDetail) {
            return { isPlaceDetail: true }
        }

        // This is the happy path
        const hasSearchResults = await page.$$('a.hfpxzc');
        if (hasSearchResults.length > 0) {
            return { hasResults: true };
        }

        await page.waitForTimeout(CHECK_LOAD_OUTCOMES_EVERY_MS);
    }
}

/**
 * Method adds places from listing to queue
 * @param {{
 *  page: Puppeteer.Page,
 *  searchString: string,
 *  requestQueue: Apify.RequestQueue,
 *  request: Apify.Request,
 *  helperClasses: typedefs.HelperClasses,
 *  scrapingOptions: typedefs.ScrapingOptions,
 *  crawler: Apify.PuppeteerCrawler,
 * }} options
 */
module.exports.enqueueAllPlaceDetails = async ({
                                          page,
                                          searchString,
                                          requestQueue,
                                          request,
                                          crawler,
                                          scrapingOptions,
                                          helperClasses,
                                      }) => {
    const { geolocation, maxAutomaticZoomOut, exportPlaceUrls } = scrapingOptions;
    const { stats, placesCache, maxCrawledPlacesTracker, exportUrlsDeduper } = helperClasses;

    // The error property is a way to propagate errors from the response handler to this synchronous context
    /** @type {typedefs.PageStats} */
    const pageStats = { error: null, isDataPage: false, enqueued: 0, pushed: 0, totalEnqueued: 0,
        totalPushed: 0, found: 0, totalFound: 0, pageNum: 1 }

    const responseHandler = enqueuePlacesFromResponse({
        page,
        requestQueue,
        searchString,
        request,
        exportPlaceUrls,
        geolocation,
        placesCache,
        stats,
        maxCrawledPlacesTracker,
        exportUrlsDeduper,
        crawler,
    });

    page.on('response', async (response) => {
        await responseHandler(response, pageStats);
    });

    // Special case that works completely differently
    if (searchString?.startsWith('all_places_no_search')) {
        await Apify.utils.sleep(10000);
        // dismiss covid warning panel
        try {
            await page.click('button[aria-label*="Dismiss"]')
        } catch (e) {

        }
        // if specified by user input call OCR to recognize pins
        const isPinsFromOCR = searchString.endsWith('_ocr');
        const pinPositions =  isPinsFromOCR ? await getScreenshotPinsFromExternalActor(page) : [];
        if (isPinsFromOCR && !pinPositions?.length) {
            // no OCR results, do not fall back to regular mouseMove
            return;
        }
        await moveMouseThroughPage(page, pageStats, pinPositions);
        log.info(`[SEARCH]: Mouse moving finished, enqueued ${pageStats.enqueued}/${pageStats.found} out of found: ${page.url()}`)
        return;
    }

    // there is no searchString when startUrls are used
    if (searchString) {
        await page.waitForSelector('#searchboxinput', { timeout: 15000 });
        await page.type('#searchboxinput', searchString);
    }

    await sleep(5000);
    try {
        await page.click('#searchbox-searchbutton');
    } catch (e) {
        const error = /** @type {Error} */ (e);
        log.warning(`click#searchbox-searchbutton ${error.message}`);
        try {
             /** @type {Puppeteer.ElementHandle<HTMLElement> | null} */
            const retryClickSearchButton = await page.$('#searchbox-searchbutton');
            if (!retryClickSearchButton) {
                throw new Error('Retry click search button was not found on the page.');
            }
            await retryClickSearchButton.evaluate(b => b.click());
        } catch (eOnRetry) {
            const eOnRetryError = /** @type {Error} */ (eOnRetry);
            log.warning(`retryClickSearchButton ${eOnRetryError.message}`);
            await page.keyboard.press('Enter');
        }
    }
    await sleep(5000);
    await waitForGoogleMapLoader(page);

    const startZoom = /** @type {number} */ (parseZoomFromUrl(page.url()));

    const logBase = `[SEARCH][${searchString}]`;

    // There can be many states other than loaded results
    const { noOutcomeLoaded, hasNoResults, isBadQuery, isPlaceDetail } = await waitForSearchResults(page);

    if (noOutcomeLoaded) {
        throw new Error(`${logBase} Don't recognize the loaded content - ${request.url}`);
    }

    if (isBadQuery) {
        log.warning(`${logBase} Finishing search because this query yielded no results - ${request.url}`);
        return;
    }

    if (hasNoResults) {
        log.warning(`${logBase} Finishing search because there are no results for this query - ${request.url}`);
        return;
    } 

    // If we search for very specific place, it loads it directly
    // but enqueuing will still process it in separate page
    if (isPlaceDetail) {
        log.warning(`${logBase} Finishing scroll because we loaded a single place page directly - ${request.url}`);
        return;
    }

    let numberOfEmptyScrolls = 0;
    let lastNumberOfResultsLoadedTotally = 0;

    // Main scrolling/enqueueing loop starts
    for (;;) {
        const logBaseScroll = `${logBase}[SCROLL: ${pageStats.pageNum}]:`
        // Check if we grabbed all results for this search
        const noMoreResults = await page.$('.HlvSq');
        if (noMoreResults) {
            log.info(`${logBase} Finishing search because we reached all ${pageStats.totalFound} results - ${request.url}`);
            return;
        }

        // We also check for number of scrolls that do not trigger more places to have a hard stop
        if (lastNumberOfResultsLoadedTotally === pageStats.totalFound) {
            numberOfEmptyScrolls++;
        } else {
            numberOfEmptyScrolls = 0;
        }
        lastNumberOfResultsLoadedTotally = pageStats.totalFound;
        // They load via XHR only each batch of 20 places so there will be about 6 of empty scrolls
        // but should not be too many
        if (numberOfEmptyScrolls >= 10) {
            log.warning(`${logBaseScroll} Finishing scroll with ${pageStats.totalFound} results because scrolling doesn't yiled any more results (and is less than maximum ${MAX_PLACES_PER_PAGE}) --- ${request.url}`);
            return;
        }

        if (pageStats.error) {
            const snapshotKey = `SEARCH-RESPONSE-ERROR-${Math.random()}`;
            await Apify.setValue(snapshotKey, pageStats.error.responseBody, { contentType: 'text/plain' });
            const snapshotUrl = `https://api.apify.com/v2/key-value-stores/${Apify.getEnv().defaultKeyValueStoreId}/records/ERROR-SNAPSHOTTER-STATE`
            throw `${logBaseScroll} Error occured, will retry the page: ${pageStats.error.message}\n`
                + ` Storing response body for debugging: ${snapshotUrl}\n`
                + `${request.url}`;
        }

        if (!maxCrawledPlacesTracker.canEnqueueMore(searchString || request.url)) {
            // no need to log here because it is logged already in
            return;
        }

        // If Google auto-zoomes too far, we might want to end the search
        let finishBecauseAutoZoom = false;
        if (typeof maxAutomaticZoomOut === 'number') {
            const actualZoom = /** @type {number} */ (parseZoomFromUrl(page.url()));
            // console.log('ACTUAL ZOOM:', actualZoom, 'STARTED ZOOM:', startZoom);
            const googleZoomedOut = startZoom - actualZoom;
            if (googleZoomedOut > maxAutomaticZoomOut) {
                finishBecauseAutoZoom = true;
            }
        }

        if (finishBecauseAutoZoom) {
            log.warning(`${logBaseScroll} Finishing search because Google zoomed out `
                + 'further than maxAutomaticZoomOut. Current zoom: '
                + `${parseZoomFromUrl(page.url())} --- ${searchString} - ${request.url}`);
            return;
        }

        if (pageStats.totalFound >= MAX_PLACES_PER_PAGE) {
            log.warning(`${logBaseScroll} Finishing scrolling with ${pageStats.totalFound} results for this page because we found maximum (${MAX_PLACES_PER_PAGE}) places per page - ${request.url}`);
            return;
        }

        
        // We wait between 2 and 4 sec to simulate real scrolling
        await page.waitForTimeout(2000 + Math.ceil(2000 * Math.random()))
        // We need to have mouse in the left scrolling panel
        await page.mouse.move(10, 300);
        await page.waitForTimeout(100);
        // scroll down the panel
        await page.mouse.wheel({ deltaY: 800 });
        // await waitForGoogleMapLoader(page);
        pageStats.pageNum++;
    }
};
