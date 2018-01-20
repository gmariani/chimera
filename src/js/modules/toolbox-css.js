const css = (el, prop, val = null) => {
    // Set
    if (val !== null) {
        el.style[prop] = val;
        return el;
    }

    // Get
    const view = el.ownerDocument.defaultView || window;
    const computed = view.getComputedStyle(el);
    return computed.getPropertyValue(prop) || computed[prop];
};

// innerWidth / innerHeight - includes padding but not border
const getInnerWidth = (el) => {
    return (el !== null && el === el.window) ? el.document.documentElement.clientWidth : el.clientWidth;
};

const getInnerHeight = (el) => {
    return (el !== null && el === el.window) ? el.document.documentElement.clientHeight : el.clientHeight;
};

// outerWidth / outerHeight - includes padding, border, and optionally margin
const getOuterWidth = (el) => {
    // $( window ).outerWidth/Height return w/h including scrollbars (gh-1729)
    return (el !== null && el === el.window) ? el.innerWidth : el.offsetWidth;
};

const getOuterHeight = (el) => {
    // $( window ).outerWidth/Height return w/h including scrollbars (gh-1729)
    return (el !== null && el === el.window) ? el.innerHeight : el.offsetHeight;
};

// height / width - element height (no padding, margin, or border)
// http://codeblog.cz/vanilla/style.html
// value is int
const width = (el, value = null) => {
    // Get window width
    if ( el !== null && el === el.window ) return el.document.documentElement.clientWidth;

    // Get document width
    if (9 === el.nodeType) {
        const doc = el.documentElement;
        // Either scroll[Width/Height] or offset[Width/Height] or client[Width/Height],
        // whichever is greatest
        return Math.max(
            el.body.scrollWidth, doc.scrollWidth,
            el.body.offsetWidth, doc.offsetWidth,
            doc.clientWidth
        );
    }

    // Element
    if (null === value) {
        // Get
        return parseInt( css(el, 'width') );
    } else {
        // Set
        css(el, 'width', parseInt(value) + 'px');
        return el;
    }
};

const height = (el, value = null) => {
    // Get window width
    if (el !== null && el === el.window) return el.document.documentElement.clientHeight;

    // Get document width
    if (9 === el.nodeType) {
        var doc = el.documentElement;
        // Either scroll[Width/Height] or offset[Width/Height] or client[Width/Height],
        // whichever is greatest
        return Math.max(
            el.body.scrollHeight, doc.scrollHeight,
            el.body.offsetHeight, doc.offsetHeight,
            doc.clientHeight
        );
    }

    // Element
    if (null === value) {
        // Get
        return parseInt( css(el, 'height') );
    } else {
        // Set
        css(el, 'height', parseInt(value) + 'px');
        return el;
    }
};

const hasClass = (el, strClass) => {
    return el.classList ? el.classList.contains(strClass) : new RegExp('(^| )' + strClass + '( |$)', 'gi').test(el.className);
};

const addClass = (el, strClass) => {
    if (el.classList) {
        el.classList.add(strClass);
    } else {
        el.className += ' ' + strClass;
    }
    return el;
};

const removeClass = (el, strClass) => {
    if (el.classList) {
        el.classList.remove( strClass );
    } else {
        el.className = el.className.replace( new RegExp('(^|\\b)' + strClass.split(' ').join('|') + '(\\b|$)', 'gi'), ' ' );
    }
    return el;
};

export {
    css,
    getInnerWidth,
    getInnerHeight,
    getOuterWidth,
    getOuterHeight,
    width,
    height,
    hasClass,
    addClass,
    removeClass
};