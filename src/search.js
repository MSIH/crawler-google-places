const Apify = require('apify');

const { GEO_TO_DEFAULT_ZOOM } = require('./consts');
const { getGeolocation, findPointsInPolygon } = require('./polygon');

const { log } = Apify.utils;

/**
 * @param {{
 *  country: string | undefined,
 *  state: string | undefined,
 *  county: string | undefined,
 *  city: string | undefined,
 *  postalCode: string | undefined
 * }} geolocation
 */
const getMatchingDefaultZoom = ({ country, state, county, city, postalCode }) => {
    // We start with the most specific that should get highest zoom
    if (postalCode) {
        return GEO_TO_DEFAULT_ZOOM.postalCode;
    }
    if (city) {
        return GEO_TO_DEFAULT_ZOOM.city;
    }
    if (county) {
        return GEO_TO_DEFAULT_ZOOM.county;
    }
    if (state) {
        return GEO_TO_DEFAULT_ZOOM.state;
    }
    if (country) {
        return GEO_TO_DEFAULT_ZOOM.country;
    }
    return GEO_TO_DEFAULT_ZOOM.default;
}

/**
 * @param {{
 *  lat: string | undefined,
 *  lng: string | undefined,
 *  userOverridingZoom: number | undefined,
 *  country: string | undefined,
 *  state: string | undefined,
 *  county: string | undefined,
 *  city: string | undefined,
 *  postalCode: string | undefined,
 *  polygon: any | undefined,
 * }} options
 */
exports.prepareSearchUrls = async ({ lat, lng, userOverridingZoom, country, state, county, city, postalCode, polygon }) => {
    // Base part of the URLs to make up the startRequests
    const startUrlSearches = [];

    /** @type {any} */
    let geo;
    
    const zoom = userOverridingZoom || getMatchingDefaultZoom({ country, state, county, city, postalCode });
    log.info(`Using zoom ${zoom} to define the search`);

    // preference for startUrlSearches is state & city > lat & lng
    // because people often use both and we want to split the map for more results
    if (polygon || country || state || county || city || postalCode) {
        geo = polygon || await Apify.getValue('GEO');
        // Takes from KV or create a new one
        geo = geo || await getGeolocation({ country, state, county, city, postalCode });

        Apify.events.on('migrating', async () => {
            await Apify.setValue('GEO', geo);
        });

        const points = await findPointsInPolygon(geo, zoom);
        for (const point of points) {
            startUrlSearches.push(`https://www.google.com/maps/@${point.lat},${point.lon},${zoom}z/search`);
        }
        log.info(`Created ${startUrlSearches.length} search page URLs for extraction to ensure maximum results is captured.`);
    } else if (lat || lng) {
        if (!lat || !lng) {
            throw 'You have to define both lat and lng!';
        }
        startUrlSearches.push(`https://www.google.com/maps/@${lat},${lng},${zoom}z/search`);
    } else {
        startUrlSearches.push('https://www.google.com/maps/search/');
    }
    return { startUrlSearches, geo };
};
