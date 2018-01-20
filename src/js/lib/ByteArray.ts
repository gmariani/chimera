/**
 * @author Gabriel Mariani
 *
 * http://www.adamia.com/blog/high-performance-javascript-port-of-actionscript-byteArray
 */
    
var fromCharCode = String.fromCharCode,
    pow = Math.pow,
    min = Math.min,
    max = Math.max,
    TWOeN23 = pow(2, -23);

var ByteArray = function( data, endian ) {
    if ( data === undefined ) {
        data = new ArrayBuffer(1024 * 1024 * 5); // 5 mb max size
        this.length = 0; // we track this since the arraybuffer is 5mb
    } else {
        this.length = data.byteLength;
    }
    
    this.position = 0;
    this.endian = ( endian !== undefined ) ? endian : ByteArray.BIG_ENDIAN;
    this._bitBuffer = null;
    this._bitPosition = 8;
    this._buffer = data;
    this._dataview = new DataView( this._buffer );
    
    // Add redundant members that match actionscript for compatibility
    var funcMap = {
        // SWF
        readUnsignedByte:	'getUint8',
        readString:	'getString',
        readUB:		'getUBits',
        readSB:		'getBits',
        readSI8:	'getInt8',
        readSI16:	'getInt16',
        readSI32:	'getInt32',
        readUI8:	'getUint8',
        readUI16:	'getUint16',
        readUI32:	'getUint32',
        
        // General
        getByteAt:	'getInt8At',
        getUByteAt:	'getUint8At',
        
        getUByte:	'getUint8',
        getBoolean: 'getUint8', 
        getUShort:	'getUint16',
        getUInt:	'getUint32', 
        getULong:	'getUint32', 
        getByte:	'getInt8',
        getShort:	'getInt16',
        getInt: 	'getInt32', 
        getLong: 	'getInt32', 
        
        setUByte:	'setUint8',
        setBoolean:	'setUint8',
        setUShort:	'setUint16',
        setUInt:	'setUint32',
        setByte:	'setInt8',
        setShort:	'setInt16',
        setInt:		'setInt32',
        setLong:	'setInt32'
    };
    
    for ( var func in funcMap ) {
        this[func] = this[funcMap[func]];
    }
};

ByteArray.BIG_ENDIAN = 'bigEndian';
ByteArray.LITTLE_ENDIAN = 'littleEndian';

const getInt8 = (dataview:DataView, position:number) => {
    return dataview.getInt8( position );
}



getInt8: function() {
    var val = this._dataview.getInt8( this.position++ );
    this.align();
    return val;
},
align: function() {
    this._bitPosition = 8;
    this._bitBuffer = null;
},

ByteArray.prototype = {
    
    resizeBuffer: function( capacity ) {
        var buffer = new ArrayBuffer( capacity );
        new Int8Array( buffer ).set( new Int8Array( this._buffer ) );
        this._buffer = buffer;
        this._dataview = new DataView( buffer );
    },
    
    getBytesAvailable: function() {
        return this.length - this.position;
    },
    
    seek: function( offset, absolute ) {
        this.position = ( absolute ? 0 : this.position ) + offset;
        this.align();
        return this;
    },
    
    getBytesAt: function( pos, length, bigEnd ) {
        var origPos = this.position, val;
        this.position = pos;
        val = this.getBytes( length, bigEnd );
        this.position = origPos;
        return val;
    },
    
    getBytes: function( length, bigEnd ) {
        var bytes = [], i, startPos;
        
        if ( this.getBytesAvailable() >= length ) {
            if ( bigEnd ) {
                // In order
                for ( i = 0; i < length; i++ ) {
                    bytes.push( this.getUint8() );
                }
            } else {
                // Reverse
                startPos = this.position;
                for ( i = length; i > 0; i-- ) {
                    bytes.push( this.getUint8At( i + startPos ) );
                }
                this.position = startPos + length;
            }
        } else {
            trace( 'Not enough data to read ' + length + ' bytes' );
        }
        
        return bytes;
    },
    
    setBytes: function(value/*:ByteArray|Array*/) {
        var arr, i;
        trace('setBytes', Array.isArray(value));
        if (Array.isArray(value)) {
            arr = value;//new Int8Array(value.length);
            //arr.set(value);
        } else {
            arr = new Int8Array(value._dataview.buffer);
        }
        
        for (i = 0; i < value.length; i++) {
            this.setByte(arr[i]);
        }
    },
    
    /*deflate: function(parseLimit) {
        var zip = new ZipUtil(this);
        return zip.deflate(parseLimit);
    },*/

    /////////////////////////////////////////////////////////
    // Integers
    /////////////////////////////////////////////////////////

    getByteAt: function( pos ) {
        return this._dataview[pos];
    },
    
    setByteAt: function( pos, value ) {
        this._dataview[pos] = value;
    },

    // Unsigned Number
    /*getNumber: function( numBytes, bigEnd ) {
        var val = 0;
        if (bigEnd == undefined) bigEnd = !!(this.endian == ByteArray.BIG_ENDIAN);
        if (bigEnd) {
            while (numBytes--) val = (val << 8) | this.getByteAt(this.position++);
        } else {
            var o = this.position, i = o + numBytes;
            while(i > o) val = (val << 8) | this.getByteAt(--i);
            this.position += numBytes;
        }
        
        this.align();
        return val;
    },
    
    setNumber: function( numBytes, value, bigEnd ) {
        //http://jsfromhell.com/classes/binary-parser
        var bits = numBytes * 8, max = pow(2, bits), r = [];
        //(value >= max || value < -(max >> 1)) && this.warn('encodeInt::overflow') && (value = 0);
        if (value < 0) value += max;
        for(; value; r[r.length] = fromCharCode(value % 256), value = Math.floor(value / 256));
        for(bits = -(-bits >> 3) - r.length; bits--; r[r.length] = '\0');
        if (bigEnd == undefined) bigEnd = !!(this.endian == ByteArray.BIG_ENDIAN);
        var numStr = (bigEnd ? r.reverse() : r).join('');
        this.setBytes(numStr);
        this.position += numBytes;
        this.align();
    },*/

    // Signed Number
    /*getNumber: function(numBytes, bigEnd) {
        var val = this.getNumber(numBytes, bigEnd), 
        numBits = numBytes * 8, 
        _max = pow(2, numBits);
        if (val >> (numBits - 1)) val -= pow(2, numBits);
        return val;
    },
    
    setNumber: function(numBytes, value, bigEnd) {
        this.setNumber(numBytes, value, bigEnd)
    },*/

    
    
    getInt8At: function( pos ) {
        return this._dataview.getInt8( pos );
    },
    
    getUint8: function() {
        var val = this._dataview.getUint8( this.position );
        this.position += 1;
        this.align();
        return val;
    },
    
    getUint8At: function( pos ) {
        return this._dataview.getUint8( pos );
    },
    
    setInt8: function( value ) {
        var val = this._dataview.setInt8( this.position, parseInt( value ) );
        this.position++;
        this.length++;
        this.align();
        return val;
    },
    
    setUint8: function(value) {
        var val = this._dataview.setUint8( this.position, parseInt( value ) );
        this.position += 1;
        this.length += 1;
        this.align();
        return val;
    },

    getInt16: function( bigEnd ) {
        var val = this._dataview.getInt16( this.position, bigEnd );
        this.position += 2;
        this.align();
        return val;
    },
    
    getInt16At: function( pos, bigEnd ) {
        return this._dataview.getInt16( pos, bigEnd );
    },
    
    getUint16: function( bigEnd ) {
        var val = this._dataview.getUint16( this.position, bigEnd );
        this.position += 2;
        this.align();
        return val;
    },
    
    getUint16At: function( pos, bigEnd ) {
        return this._dataview.getUint16( pos, bigEnd );
    },
    
    setInt16: function( value, bigEnd ) {
        var val = this._dataview.setInt16( this.position, value, bigEnd );
        this.position += 2;
        this.length += 2;
        this.align();
        return val;
    },
    
    setUint16: function( value, bigEnd ) {
        var val = this._dataview.setUint16( this.position, value, bigEnd );
        this.position += 2;
        this.length += 2;
        this.align();
        return val;
    },

    getInt32: function( bigEnd ) {
        var val = this._dataview.getInt32( this.position, bigEnd );
        this.position += 4;
        this.align();
        return val;
    },
    
    getInt32At: function( pos, bigEnd ) {
        return this._dataview.getInt32( pos, bigEnd );
    },
    
    getUint32: function( bigEnd ) {
        var val = this._dataview.getUint32( this.position, bigEnd );
        this.position += 4;
        this.align();
        return val;
    },
    
    getUint32At: function( pos, bigEnd ) {
        return this._dataview.getUint32( pos, bigEnd );
    },
    
    setInt32: function( value, bigEnd ) {
        var val = this._dataview.setInt32( this.position, value, bigEnd );
        this.position += 4;
        this.length += 4;
        this.align();
        return val;
    },

    setUint32: function( value, bigEnd ) {
        var val = this._dataview.setUint32( this.position, value, bigEnd );
        this.position += 4;
        this.length += 4;
        this.align();
        return val;
    },

    /*getUint24: function( bigEnd ) {
        return this.getNumber( 3, bigEnd );
    },
    
    setUint24: function( value, bigEnd ) {
        this.setNumber( 3, value, bigEnd );
    },*/

    /////////////////////////////////////////////////////////
    // Fixed-point numbers
    /////////////////////////////////////////////////////////

    getFixed: function() {
        return this.getBits( 32 ) * pow( 2, -16 );
    },

    getFixed8: function() {
        return this.getBits( 16 ) * pow( 2, -8 );
    },

    getFixedBits: function( numBits ) {
        return this.getBits( numBits ) * pow( 2, -16 );
        
        // SWFAssist
        //return this.getBits(numBits) / 65536;
    },

    /////////////////////////////////////////////////////////
    // Floating-point numbers
    /////////////////////////////////////////////////////////

    getFloat32: function( bigEnd ) {
        var val = this._dataview.getFloat32( this.position, bigEnd );
        this.position += 4;
        this.align();
        return val;
    },
    
    getFloat32At: function( pos, bigEnd ) {
        return this._dataview.getFloat32( pos, bigEnd );
    },
    
    setFloat32: function( value, bigEnd ) {
        var val = this._dataview.setFloat32( this.position, value, bigEnd );
        this.position += 4;
        this.length += 4;
        this.align();
        return val;
    },

    // 8 byte IEEE-754 double precision floating point value in network byte order (sign bit in low memory).
    getFloat64: function( bigEnd ) {
        var val = this._dataview.getFloat64( this.position, bigEnd );
        this.position += 8;
        this.align();
        return val;
    },
    
    getFloat64At: function( pos, bigEnd ) {
        return this._dataview.getFloat64( pos, bigEnd );
    },
    
    setFloat64: function( value, bigEnd ) {
        var val = this._dataview.setFloat64( this.position, value, bigEnd );
        this.position += 8;
        this.length += 8;
        this.align();
        return val;
    },

    /////////////////////////////////////////////////////////
    // Encoded integer
    /////////////////////////////////////////////////////////

    getEncodedUint32: function() {
        var val = 0;
        for (var i = 0; i < 5; i++) {
            var num = this.getUint8At(this.position++);
            val = val | ((num & 0x7f) << (7 * i));
            if (!(num & 0x80)) break;
        }
        return val;
    },
    
    // setEncodedUint32

    /////////////////////////////////////////////////////////
    // Bit values
    /////////////////////////////////////////////////////////

    align: function() {
        this._bitPosition = 8;
        this._bitBuffer = null;
    },
    
    getBit: function() {
        return this.getBits( 1 );
    },
    
    getUBit: function() {
        return this.getUBits( 1 );
    },
    
    setBit: function( value ) {
        this.setBits( value, 1 );
    },
    
    setUBit: function( value ) {
        this.setUBits( value, 1 );
    },
    
    getBits: function( numBits ) {
        if( !numBits ) return 0;
        
        var val = this.getUBits( numBits );
        
        // SWFWire
        var leadingDigit = val >>> ( numBits - 1 );
        if ( leadingDigit === 1 ) return -( ( ~val & ( ~0 >>> -numBits ) ) + 1 );
        return val;
        
        // SWFAssist
        //var shift = 32 - numBits;
        //var result = (val << shift) >> shift;
        //return result;
        
        // Gordon
        //if (val >> (numBits - 1)) val -= pow(2, numBits);
        //return val;
    },

    getUBits: function( numBits, bigEnd ) {
        var val = 0, i;
        for ( i = 0; i < numBits; i++ ) {
            if ( 8 === this._bitPosition ) {
                this._bitBuffer = this.getUint8();
                this._bitPosition = 0;
            }
            
            if ( !bigEnd ) { // Least significant bit
                val |= ( this._bitBuffer & ( 0x01 << this._bitPosition++ ) ? 1 : 0 ) << i;
            } else {
                val = ( val << 1 ) | ( this._bitBuffer & ( 0x80 >> this._bitPosition++ ) ? 1 : 0 );
            }
        }
        
        return val;
    },
    
    setBits: function( value, numBits ) {
        this.setUBits( value | ( ( value < 0 ? 0x80000000 : 0x00000000 ) >> ( 32 - numBits ) ), numBits );
    },
    
    setUBits: function( value, numBits ) {
        if ( 0 === numBits ) return;
        
        if ( this._bitPosition === 0 ) this._bitPosition = 8;
        
        while ( numBits > 0 ) {
            while ( this._bitPosition > 0 && numBits > 0 ) {
                if ( ( value & ( 0x01 << ( numBits - 1 ) ) ) !== 0 ) {
                    this._bitBuffer = this._bitBuffer | ( 0x01 << ( this._bitPosition - 1 ) );
                }
                
                --numBits;
                --this._bitPosition;
            }
            
            if ( 0 === this._bitPosition ) {
                this.setUint8( this._bitBuffer );
                this._bitBuffer = 0;
                
                if ( numBits > 0 ) this._bitPosition = 8;
            }
        }
    },

    /////////////////////////////////////////////////////////
    // String
    /////////////////////////////////////////////////////////
    
    getASCIIChar: function() {
        return fromCharCode( this.getUint8() );
    },
    
    // setASCIIChar
    
    getASCIIBytes: function( numChars ) {
        var str = null, 
            chars = [],
            endPos = this.position + numChars;
        while ( this.position < endPos ) {
            chars.push( fromCharCode( this.getUint8() ) );
        }
        str = chars.join('');
        return str;
    },
    
    getASCIIBytesAt: function( pos, numChars ) {
        var origPos = this.position, val;
        this.position = pos;
        val = this.getASCIIBytes( numChars );
        this.position = origPos;
        return val;
    },
    
    // setASCIIBytes
    
    // getASCIIString
    
    // setASCIIString
    
    /**
    Reads a single UTF-8 character
    http://en.wikipedia.org/wiki/UTF-8
    */
    getUTFChar: function() {
        var code_unit1, code_unit2, code_unit3, code_unit4;
        
        function error4() {
            this.position -= 3;
            return error1();
        }
        
        function error3() {
            this.position -= 2;
            return error1();
        }
        
        function error2() {
            this.position -= 1;
            return error1();
        }
        
        function error1() {
            return fromCharCode( code_unit1 + 0xDC00 );
        }
        
        code_unit1 = this.getUint8();
        if ( code_unit1 < 0x80 ) {
            return fromCharCode( code_unit1 );
        } else if ( code_unit1 < 0xC2 ) {
            /* continuation or overlong 2-byte sequence */
            return error1();
        } else if ( code_unit1 < 0xE0 ) {
            /* 2-byte sequence */
            code_unit2 = this.getUint8();
            if ( ( code_unit2 & 0xC0 ) != 0x80 ) return error2();
            return fromCharCode( ( code_unit1 << 6 ) + code_unit2 - 0x3080 );
        } else if ( code_unit1 < 0xF0 ) {
            /* 3-byte sequence */
            code_unit2 = this.getUint8();
            if ( ( code_unit2 & 0xC0 ) != 0x80 ) return error2();
            if ( code_unit1 == 0xE0 && code_unit2 < 0xA0 ) return error2(); /* overlong */
            code_unit3 = this.getUint8();
            if ( ( code_unit3 & 0xC0 ) != 0x80 ) return error3();
            return fromCharCode( ( code_unit1 << 12 ) + ( code_unit2 << 6 ) + code_unit3 - 0xE2080 );
        } else if ( code_unit1 < 0xF5 ) {
            /* 4-byte sequence */
            code_unit2 = this.getUint8();
            if ( ( code_unit2 & 0xC0 ) != 0x80 ) return error2();
            if ( code_unit1 == 0xF0 && code_unit2 < 0x90 ) return error2(); /* overlong */
            if ( code_unit1 == 0xF4 && code_unit2 >= 0x90 ) return error2(); /* > U+10FFFF */
            code_unit3 = this.getUint8();
            if ( ( code_unit3 & 0xC0 ) != 0x80 ) return error3();
            code_unit4 = this.getUint8();
            if ( ( code_unit4 & 0xC0 ) != 0x80 ) return error4();
            return fromCharCode( ( code_unit1 << 18 ) + ( code_unit2 << 12 ) + ( code_unit3 << 6 ) + code_unit4 - 0x3C82080 );
        } else {
            /* > U+10FFFF */
            return error1();
        }

        return error1();
    },
    
    setUTFChar: function( rawChar ) {
        var code_point = rawChar.charCodeAt( 0 );
        if ( code_point < 0x80 ) {
            this.setUint8( code_point );
        } else if ( code_point <= 0x7FF ) {
            this.setUint8( ( code_point >> 6 ) + 0xC0 );
            this.setUint8( ( code_point & 0x3F ) + 0x80 );
        } else if ( code_point <= 0xFFFF ) {
            this.setUint8( ( code_point >> 12 ) + 0xE0 );
            this.setUint8( ( ( code_point >> 6 ) & 0x3F ) + 0x80 );
            this.setUint8( ( code_point & 0x3F ) + 0x80 );
        } else if ( code_point <= 0x10FFFF ) {
            this.setUint8( ( code_point >> 18 ) + 0xF0 );
            this.setUint8( ( ( code_point >> 12 ) & 0x3F ) + 0x80 );
            this.setUint8( ( ( code_point >> 6 ) & 0x3F ) + 0x80 );
            this.setUint8( ( code_point & 0x3F ) + 0x80 );
        } else {
            throw new Error( 'setUTFChar: Invalid char code' );
        }
    },
    
    getUTFBytes: function( numChars ) {
        var str = null, 
            chars = [],
            endPos = this.position + numChars;
        while ( this.position < endPos ) {
            chars.push( this.getUTFChar() );
        }
        str = chars.join( '' );
        return str;
    },
    
    setUTFBytes: function( value ) {
        var chars = value.split( '' ), l = value.length;
        while ( l-- ) {
            this.setUTFChar( chars.shift() );
        }
    },
    
    /**
    Reads a UTF-8 string from the byte stream. The string is assumed to be 
    prefixed with an unsigned short indicating the length in bytes. 
    */
    getUTFString: function() {
        var len = this.getUint16();
        return this.getUTFBytes( len );
    },
    
    setUTFString: function( value ) {
        var startPos = this.position;
        this.setUint16( value.length );
        this.setUTFBytes( value );
        
        // With UTF characters, the bytes can be longer than the original string
        // We write the bytes, then subtract the guessed length earlier
        var utfLen = this.position - startPos - 2;
        // Here we overwrite the original guess length
        this._dataview.setUint16( startPos, utfLen );
    },

    /*
    In SWF 5 or earlier, STRING values are encoded using either ANSI (which is a superset of
    ASCII) or shift-JIS (a Japanese encoding). You cannot indicate the encoding that is used;
    instead, the decoding choice is made according to the locale in which Flash Player is running.
    This means that text content in SWF 5 or earlier can only be encoded in ANSI or shift-JIS,
    and the target audience must be known during authoring—otherwise garbled text results.

    In SWF 6 or later, STRING values are always encoded by using the Unicode UTF-8 standard.
    This is a multibyte encoding; each character is composed of between one and four bytes.
    UTF-8 is a superset of ASCII; the byte range 0 to 127 in UTF-8 exactly matches the ASCII
    mapping, and all ASCII characters 0 to 127 are represented by just one byte. UTF-8
    guarantees that whenever a character other than character 0 (the null character) is encoded by
    using more than one byte, none of those bytes are zero. This avoids the appearance of internal
    null characters in UTF-8 strings, meaning that it remains safe to treat null bytes as string
    terminators, just as for ASCII strings.
    */
    getString: function( numChars, simple ) {
        var str = null;
        if ( undefined != numChars ) {
            //str = this._dataview.substr( this.position, numChars );
            str = this.getASCIIBytes(numChars);
            //str = this.getUTFBytes(numChars);
            this.position += numChars;
        } else {
            var chars = [], i = this.length - this.position;
            while ( i-- ) {
                var code = this.getByteAt(this.position++), code2, code3;
                if (code) {
                    if (simple) {
                        // Read raw
                        chars.push(fromCharCode(code));
                    } else {
                        // Fix multibyte UTF characters
                        if (code < 128) {
                            chars.push(fromCharCode(code));
                        } else if ((code > 191) && (code < 224)) {
                            code2 = this.getByteAt(this.position++);
                            chars.push(fromCharCode(((code & 31) << 6) | (code2 & 63)));
                            i--;
                        } else {
                            code2 = this.getByteAt(this.position++);
                            code3 = this.getByteAt(this.position++);
                            chars.push(fromCharCode(((code & 15) << 12) | ((code2 & 63) << 6) | (code3 & 63)));
                            i -= 2;
                        }
                    }
                } else {
                    break;
                }
            }
            str = chars.join('');
        }
        
        return str;
    },
    
    /////////////////////////////////////////////////////////
    // Boolean
    /////////////////////////////////////////////////////////
    
    /*getBool: function( numBits ) {
        return !!this.getUBit( numBits || 1 );
    },*/
    
    // setBool
};

//})();