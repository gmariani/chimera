const $ = (selectors, doc=document) => {
    const result = doc.querySelectorAll(selectors);
    return (1 === result.length) ? result[0] : result;
};

const ready = (func, doc=document) => {
    if (doc.readyState !== 'loading') {
        func();
    } else {
        doc.addEventListener('DOMContentLoaded', func);
    }
};

const formatBytes = (bytes=0, precisionPref=2) => {
    if (bytes <= 0) return '0 B';
    if (precisionPref <= -1) return bytes + ' B';

    const precision = Math.min(precisionPref, 21);
    const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
    const mod = 1024;
    let i = 0;
    while (bytes > mod) {
        bytes /= mod;
        i++;
    }

    return bytes.toPrecision(precision) + ' ' + units[i];
};

// https://github.com/radiovisual/zeropad
const zeroPad = (number=1, length=2) => {
    if ( isNaN(number) ) throw new SyntaxError('zeroPad requires a number or string');
    if ( isNaN(length) || length < 0 ) throw new SyntaxError('zeroPad requires a positive integer for length');

    // https://github.com/sindresorhus/negative-zero
    const prefix = Object.is(number, -0) || number < 0 ? '-' : '';
    number = Math.abs(parseFloat(number));
    const padLength = (length - String(number).length) + 1;
    const pads = new Array(padLength).join('0');
    return prefix + pads + number;
};

const htmlEntities = (str) => {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g,'&apos');
};

/*
// Thanks lodash
const throttle = (func, wait, options) => {
    var leading = true,
        trailing = true;

    if ( typeof func !== 'function' ) throw new TypeError('Value "func" not a Function');
    
    // is object
    if (!!options && (typeof options === 'object' || typeof options === 'function')) {
        leading = 'leading' in options ? !!options.leading : true;
        trailing = 'trailing' in options ? !!options.trailing : true;
    }
    
    return debounce(func, wait, {
        'leading': leading,
        'maxWait': wait,
        'trailing': trailing
    });
};

// Thanks lodash
const debounce = (func, wait, options) => {
    var lastArgs,
        lastThis,
        maxWait,
        result,
        timerId,
        lastCallTime,
        lastInvokeTime = 0,
        leading = false,
        maxing = false,
        trailing = true;

    if ( typeof func !== 'function' ) throw new TypeError('Value "func" not a Function');
    
    wait = parseInt(wait) || 0;
    
    // is object
    if ( !!options && (typeof options == 'object' || typeof options == 'function') ) {
        leading = !!options.leading;
        maxing = 'maxWait' in options;
        maxWait = maxing ? Math.max(parseInt(options.maxWait) || 0, wait) : maxWait;
        trailing = 'trailing' in options ? !!options.trailing : trailing;
    }

    function invokeFunc(time) {
        var args = lastArgs,
            thisArg = lastThis;

        lastArgs = lastThis = undefined;
        lastInvokeTime = time;
        result = func.apply(thisArg, args);
        return result;
    }

    function leadingEdge(time) {
        // Reset any `maxWait` timer.
        lastInvokeTime = time;
        // Start the timer for the trailing edge.
        timerId = setTimeout(timerExpired, wait);
        // Invoke the leading edge.
        return leading ? invokeFunc(time) : result;
    }

    function remainingWait(time) {
        var timeSinceLastCall = time - lastCallTime,
            timeSinceLastInvoke = time - lastInvokeTime,
            result = wait - timeSinceLastCall;

        return maxing ? Math.min(result, maxWait - timeSinceLastInvoke) : result;
    }

    function shouldInvoke(time) {
        var timeSinceLastCall = time - lastCallTime,
            timeSinceLastInvoke = time - lastInvokeTime;

        // Either this is the first call, activity has stopped and we're at the
        // trailing edge, the system time has gone backwards and we're treating
        // it as the trailing edge, or we've hit the `maxWait` limit.
        return (lastCallTime === undefined || (timeSinceLastCall >= wait) ||
        (timeSinceLastCall < 0) || (maxing && timeSinceLastInvoke >= maxWait));
    }

    function timerExpired() {
        var time = Date.now();
        if (shouldInvoke(time)) {
            return trailingEdge(time);
        }
        // Restart the timer.
        timerId = setTimeout(timerExpired, remainingWait(time));
    }

    function trailingEdge(time) {
        timerId = undefined;

        // Only invoke if we have `lastArgs` which means `func` has been
        // debounced at least once.
        if (trailing && lastArgs) {
            return invokeFunc(time);
        }
        lastArgs = lastThis = undefined;
        return result;
    }

    function cancel() {
        if (timerId !== undefined) {
            clearTimeout(timerId);
        }
        lastInvokeTime = 0;
        lastArgs = lastCallTime = lastThis = timerId = undefined;
    }

    function flush() {
        return timerId === undefined ? result : trailingEdge(Date.now());
    }

    function debounced() {
        var time = Date.now(),
            isInvoking = shouldInvoke(time);

        lastArgs = arguments;
        lastThis = this;
        lastCallTime = time;

        if (isInvoking) {
            if (timerId === undefined) {
                return leadingEdge(lastCallTime);
            }
            if (maxing) {
                // Handle invocations in a tight loop.
                timerId = setTimeout(timerExpired, wait);
                return invokeFunc(lastCallTime);
            }
        }
        if (timerId === undefined) {
            timerId = setTimeout(timerExpired, wait);
        }
        return result;
    }
    
    debounced.cancel = cancel;
    debounced.flush = flush;
    return debounced;
};*/

export {
    $,
    ready,
    formatBytes,
    htmlEntities,
    zeroPad
    //throttle,
    //debounce
};