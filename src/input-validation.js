const Apify = require('apify');

const typedefs = require('./typedefs'); // eslint-disable-line no-unused-vars

const { log } = Apify.utils;

// Small hack for backward compatibillity
// Previously there was a checkbox includeImages and includeReviews. It had to be on.
// maxImages and maxReviews 0 or empty scraped all
// Right now, it works like you woudl expect, 0 or empty means no images, for all images just set 99999
// If includeReviews/includeImages is not present, we process regularly
/** @param {any} input */
module.exports.makeInputBackwardsCompatible = (input) => {
    // Deprecated on 2021-08
    if (input.maxCrawledPlaces === 0) {
        input.maxCrawledPlaces = 99999999;
        log.warning('INPUT DEPRECATION: maxCrawledPlaces: 0 should no longer be used for infinite limit. '
            + 'Use maxCrawledPlaces: 99999999 instead. Setting it to 99999999 for this run.');
    }

    // Deprecated on 2020-07
    if (input.includeReviews !== undefined || input.includeImages !== undefined) {
        log.warning('INPUT DEPRECATION: includeReviews and includeImages '
        + 'input fields have been deprecated and will be removed soon! Use maxImage and maxReviews instead');
    }
    if (input.includeReviews === true && !input.maxReviews) {
        input.maxReviews = 999999;
    }

    if (input.includeReviews === false) {
        input.maxReviews = 0;
    }

    if (input.includeImages === true && !input.maxImages) {
        input.maxImages = 999999;
    }

    if (input.includeImages === false) {
        input.maxImages = 0;
    }

    // Deprecated on 2020-10-27
    if (input.forceEng) {
        log.warning('INPUT DEPRECATION: forceEng input field have been deprecated and will be removed soon! Use language instead');
        input.language = 'en';
    }

    // Deprecated on 2020-08
    if (input.searchString) {
        log.warning('INPUT DEPRECATION: searchString field has been deprecated and will be removed soon! Please use searchStringsArray instead');
        if (!input.searchStringsArray || input.searchStringsArray.length === 0) {
            input.searchStringsArray = [input.searchString];
        }
    }
};

// First we deprecate and re-map old values and then we validate
/** @param {typedefs.Input} input */
module.exports.validateInput = (input) => {
    if (!input.searchStringsArray && !input.startUrls) {
        throw 'You have to provide startUrls or searchStringsArray in input!';
    }

    if (input.searchStringsArray && !Array.isArray(input.searchStringsArray)) {
        throw 'searchStringsArray has to be an array!';
    }

    const { proxyConfig } = input;
    // Proxy is mandatory only on Apify
    if (Apify.isAtHome()) {
        // @ts-ignore
        if (!proxyConfig || !(proxyConfig.useApifyProxy || proxyConfig.proxyUrls)) {
            throw 'You have to use Apify proxy or custom proxies when running on Apify platform!';
        }
        if (proxyConfig.apifyProxyGroups
            && (proxyConfig.apifyProxyGroups.includes('GOOGLESERP') || proxyConfig.apifyProxyGroups.includes('GOOGLE_SERP'))) {
            throw 'It is not possible to crawl google places with GOOGLE SERP proxy group. Please use a different one and rerun  the crawler!';
        }
    }
};
