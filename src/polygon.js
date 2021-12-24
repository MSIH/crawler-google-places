const Apify = require('apify');
const turf = require('@turf/turf');

const typedefs = require('./typedefs'); // eslint-disable-line

const { log } = Apify.utils;
const TURF_UNIT = 'kilometers';

const GEO_TYPES = {
    MULTI_POLYGON: 'MultiPolygon',
    POLYGON: 'Polygon',
    POINT: 'Point',
    LINE_STRING: 'LineString',
};

const FEATURE_COLLECTION = 'FeatureCollection';
const FEATURE = 'Feature';

function coordinatesFromBoundingBox(boundingbox) {
    const numberBBox = boundingbox.map(Number);
    // Format for their bounding box is [lat, lat, long, long]
    // Format of their coordinate points in [long, lat]
    // First and last position must be the same and it has to be nested like this
    return [[
        [numberBBox[2], numberBBox[0]],
        [numberBBox[2], numberBBox[1]],
        [numberBBox[3], numberBBox[0]],
        [numberBBox[3], numberBBox[1]],
        [numberBBox[2], numberBBox[0]],
    ]];
}

/**
 * Checks if provided coordinates are inside a geolocation
 * If no coordinates or geo is provided, this returns true (ease of use for non geolocated searches)
 * @param { GeoJson | null | undefined } geo
 * @param {typedefs.Coordinates | null | undefined} coordinates
 */
module.exports.checkInPolygon = (geo, coordinates) => {
    if (!geo || ! coordinates) {
        return true;
    }
    const point = turf.point([coordinates.lng, coordinates.lat]);
    let included = false;
    const polygons = getPolygons(geo.geojson);
    for (const polygon of polygons) {
        included = turf.booleanContains(polygon, point);
        if (included) break;
    }
    return included;
}

/**
 * @param {{ geometry?: any; coordinates?: any; type?: any; }} geoJson
 * @param {number | undefined} distanceKilometers
 */
function getPolygons(geoJson, distanceKilometers = 5) {
    const { coordinates, type } = geoJson;
    if (type === GEO_TYPES.POLYGON) {
        return [turf.polygon(coordinates)];
    }

    if (type === FEATURE && geoJson.geometry.type === GEO_TYPES.POLYGON) {
        return [geoJson.geometry];
    }

    // We got only the point for city, lets create a circle...
    if (type === GEO_TYPES.POINT) {
        return [turf.circle(coordinates, distanceKilometers, { units: TURF_UNIT })];
    }

    // Line (road or street) - find midpoint and length and create circle
    if (type === GEO_TYPES.LINE_STRING) {
        const firstPoint = turf.point(coordinates[0]);
        const lastPoint = turf.point(coordinates[coordinates.length - 1]);
        const midPoint = turf.midpoint(firstPoint, lastPoint);

        const line = turf.lineString(coordinates);
        const length = turf.length(line, { units: TURF_UNIT });

        return [turf.circle(midPoint, length, { units: TURF_UNIT })];
    }

    // Multipolygon
    return coordinates.map((coords) => turf.polygon(coords));
}

// Sadly, even some bigger cities (Bremer­haven) are not found by the API
// Maybe we need to find a fallback
/**
 * @param {typedefs.GeolocationOptions} options
 */
module.exports.getGeolocation = async (options) => {
    const { city, state, country, postalCode, county } = options;
    const cityString = (city || '').trim().replace(/\s+/g, '+');
    const stateString = (state || '').trim().replace(/\s+/g, '+');
    const countyString = (county || '').trim().replace(/\s+/g, '+');
    const countryString = (country || '').trim().replace(/\s+/g, '+');
    const postalCodeString = (postalCode || '').trim().replace(/\s+/g, '+');

    // TODO when get more results? Currently only first match is returned!
    const res = await Apify.utils.requestAsBrowser({
        url: encodeURI(`https://nominatim.openstreetmap.org/search?country=${countryString}&state=${stateString}&county=${countyString}&city=${cityString}&postalcode=${postalCodeString}&format=json&polygon_geojson=1&limit=1&polygon_threshold=0.005`),
        headers: { referer: 'http://google.com' },
    });
    // @ts-ignore
    const body = JSON.parse(res.body);
    const data = body[0];
    if (!data) {
        throw new Error('[Geolocation]: Location not found! Try other geolocation options or contact support@apify.com.');
    }
    log.info(`[Geolocation]: Location found: ${data.display_name}, lat: ${data.lat}, long: ${data.lon}`);
    return data;
}

/**
 * Calculates distance meters per pixel for zoom and latitude.
 * @param {number} lat
 * @param {number} zoom
 */
function distanceByZoom(lat, zoom) {
    return 156543.03392 * (Math.cos((lat * Math.PI) / 180) / (2 ** zoom));
}

/**
 *  Prepare centre points grid for search
 * @param {any} location - GeoJSON
 * @param {number} zoom
 * @returns {Promise<*[]|*>} Array of points
 */
module.exports.findPointsInPolygon = async (location, zoom) => {
    let { geojson, boundingbox } = location;

    // If there are no coordinates, we will construct them from bounding box
    if (!geojson) {
        if (!boundingbox) {
            throw new Error(`[Geolocation]: Could not find any coordinates or bounding box for ${location.display_name}`);
        }
        geojson = {
            coordinates: coordinatesFromBoundingBox(boundingbox),
            type: GEO_TYPES.POLYGON,
        };
        // We fake this so it can be passed to places
        location.geojson = geojson;
    }

    const { coordinates, type } = geojson;
    if (!coordinates && ![FEATURE_COLLECTION, FEATURE].includes(type)) return [];

    const points = [];
    // If we have a point add it to result
    if (type === GEO_TYPES.POINT) {
        const [lon, lat] = coordinates;
        points.push({ lon, lat });
    }
    // If we have a line add a first and last point
    if (type === GEO_TYPES.LINE_STRING) {
        const pointsToProcess = [coordinates[0], coordinates[coordinates.length - 1]];
        pointsToProcess.forEach((point) => {
            const [lon, lat] = point;
            points.push({ lon, lat });
        });
    }
    try {
        const polygons = getPolygons(geojson, 5);

        polygons.forEach((polygon) => {
            const bbox = turf.bbox(polygon);
            // distance in meters per pixel * viewport / 1000 meters
            let distanceKilometers = distanceByZoom(bbox[3], zoom) * (800 / 1000);
            // Creates grid of points inside given polygon
            let pointGrid;
            // point grid can be empty for to large distance.
            while (distanceKilometers > 0) {
                log.debug('distanceKilometers', { distanceKilometers });
                // Use lower distance for points
                const distance = geojson.type === GEO_TYPES.POINT ? distanceKilometers / 2 : distanceKilometers;
                const options = {
                    units: 'kilometers',
                    mask: polygon,
                };
                pointGrid = turf.pointGrid(bbox, distance, options);

                if (pointGrid.features && pointGrid.features.length > 0) break;
                distanceKilometers -= 1;
            }
            pointGrid.features.forEach((feature) => {
                const [lon, lat] = feature.geometry.coordinates;
                points.push({ lon, lat });
                // points.push(feature); // http://geojson.io is nice tool to check found points on map
            });
        });
    } catch (e) {
        log.exception(e, 'Failed to create point grid', { location, zoom });
    }
    return points;
}
