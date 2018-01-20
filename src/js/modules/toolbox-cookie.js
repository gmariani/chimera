/**
 * Sets a Cookie with the given name and value.
 *
 * name	 Name of the cookie
 * value	Value of the cookie
 * [maxAge] Minutes til cookie expires
 * [path]	 Path where the cookie is valid (default: path of calling document)
 * [domain] Domain where the cookie is valid (default: domain of calling document)
 * [secure] Boolean value indicating if the cookie transmission requires a secure transmission
 */
const setCookie = (name, value, maxAge=60, path=null, domain=null, secure=null) => {
    const age = new Date();
    age.setTime(age.getTime() + maxAge * 60 * 1000);
    document.cookie = encodeURIComponent(name) + '=' + encodeURIComponent(value) +
        ((maxAge) ? '; max-age=' + age.toUTCString() : '') +
        ((null !== path) ? '; path=' + path : '') +
        ((null !== domain) ? '; domain=' + domain : '') +
        ((null !== secure) ? '; secure' : '');
};

/**
 * Gets the value of the specified cookie.
 *
 * nameName of the desired cookie.
 *
 * Returns a string containing value of specified cookie,
 * or null if cookie does not exist.
 */
const getCookie = (name) => {
    const dc = document.cookie;
    const prefix = encodeURIComponent(name) + '=';
    const startPos = dc.indexOf('; ' + prefix) === -1 ? dc.indexOf(prefix) : dc.indexOf('; ' + prefix) + 2;
    if (startPos !== 0) return null;
    const endPos = dc.indexOf(';', startPos) === -1 ? dc.length : dc.indexOf(';', startPos);
    return decodeURIComponent(dc.substring(startPos + prefix.length, endPos));
};

/**
 * Deletes the specified cookie.
 *
 * name	name of the cookie
 * [path]	path of the cookie (must be same as path used to create cookie)
 * [domain]domain of the cookie (must be same as domain used to create cookie)
 */
const deleteCookie = (name, path=null, domain=null) => {
    if (getCookie(name)) {
        document.cookie = encodeURIComponent(name) + '=' + 
            ((null !== path) ? '; path=' + path : '') +
            ((null !== domain) ? '; domain=' + domain : '') +
            '; expires=Thu, 01-Jan-70 00:00:01 GMT';
        return true;
    }
    return false;
};

export {
    setCookie,
    getCookie,
    deleteCookie
};