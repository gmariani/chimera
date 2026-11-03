/* global importScripts, postMessage, Int32Array, Uint8Array, JFXXReader, JFIFReader, AVI1Reader, OcadReader, AdobeReader, onmessage:true, ByteArray, EXIFReader */

var debug = true;

function trace() {
	if (!debug) return;
	
	var str = '';
	var arr = [];
	for (var i = 0, l = arguments.length; i < l; i++) {
		str += arguments[i];
		arr[i] = arguments[i];
		if (i != (l - 1)) str += ', ';
	}
	str += '\n';
	
	postMessage({
		type: "debug",
		message: arr
	});
	
	//dump(str);
}

importScripts('../lib/ByteArray.js');
importScripts('./jpg-lib/JFIF.js');
importScripts('./jpg-lib/JFXX.js');
importScripts('./jpg-lib/EXIF.js');
importScripts('./jpg-lib/Adobe.js');
importScripts('./jpg-lib/AVI1.js');
importScripts('./jpg-lib/Ocad.js');



/*
- The JPEG specification can be found in the ITU CCITT Recommendation T.81
	(www.w3.org/Graphics/JPEG/itu-t81.pdf)
- FlashPix
	(http://graphcomp.com/info/specs/livepicture/fpx.pdf)
	(http://www.sno.phy.queensu.ca/~phil/exiftool/TagNames/FlashPix.html)
- Everything else!
	http://www.sno.phy.queensu.ca/~phil/exiftool/

*/

// JPEGReader
var JPEGReader = (function() {
	
	var huffmanTablesAC = [], 
		huffmanTablesDC = [],
		resetInterval, 
		frame, 
		frames = [];
	
	// / START / //
	// From github
	
	var dctZigZag = new Int32Array([
		 0,
		 1,  8,
		16,  9,  2,
		 3, 10, 17, 24,
		32, 25, 18, 11, 4,
		 5, 12, 19, 26, 33, 40,
		48, 41, 34, 27, 20, 13,  6,
		 7, 14, 21, 28, 35, 42, 49, 56,
		57, 50, 43, 36, 29, 22, 15,
		23, 30, 37, 44, 51, 58,
		59, 52, 45, 38, 31,
		39, 46, 53, 60,
		61, 54, 47,
		55, 62,
		63
	]);

	var dctCos1  =  4017,   // cos(pi/16)
		dctSin1  =   799,   // sin(pi/16)
		dctCos3  =  3406,   // cos(3*pi/16)
		dctSin3  =  2276,   // sin(3*pi/16)
		dctCos6  =  1567,   // cos(6*pi/16)
		dctSin6  =  3784,   // sin(6*pi/16)
		dctSqrt2 =  5793,   // sqrt(2)
		dctSqrt1d2 = 2896;  // sqrt(2) / 2
	
	function buildHuffmanTable( codeLengths, values ) {
		var k = 0, code = [], i, j, length = 16;
		while ( length > 0 && !codeLengths[length - 1] ) {
			length--;
		}
		
		code.push({children: [], index: 0});
		var p = code[0], q;
		for ( i = 0; i < length; i++ ) {
			for ( j = 0; j < codeLengths[i]; j++ ) {
				p = code.pop();
				p.children[p.index] = values[k];
				while ( p.index > 0 ) {
					p = code.pop();
				}
				p.index++;
				code.push(p);
				while ( code.length <= i ) {
					code.push( q = { children: [], index: 0 } );
					p.children[p.index] = q.children;
					p = q;
				}
				k++;
			}
			if ( i + 1 < length ) {
				// p here points to last code
				code.push( q = { children: [], index: 0 } );
				p.children[p.index] = q.children;
				p = q;
			}
		}
		return code[0].children;
	}

	function decodeScan( file, offset, frame, components, resetInterval, spectralStart, spectralEnd, successivePrev, successive ) {
		var precision = frame.precision;
		var samplesPerLine = frame.samplesPerLine;
		var scanLines = frame.scanLines;
		var mcusPerLine = frame.mcusPerLine;
		var progressive = frame.progressive;
		var maxH = frame.maxH, maxV = frame.maxV;

		var startOffset = offset, bitsData = 0, bitsCount = 0;
		function readBit() {
			if ( bitsCount > 0 ) {
				bitsCount--;
				return ( bitsData >> bitsCount ) & 1;
			}
			//bitsData = data[offset++];
			bitsData = file.getUint8At( offset++ );
			if ( bitsData === 0xFF ) {
				//var nextByte = data[offset++];
				var nextByte = file.getUint8At( offset++ );
				if ( nextByte ) {
					throw "unexpected marker: " + ( ( bitsData << 8 ) | nextByte ).toString( 16 );
				}
				// unstuff 0
			}
			bitsCount = 7;
			return bitsData >>> 7;
		}
		
		function decodeHuffman( tree ) {
			var node = tree, bit;
			while ( ( bit = readBit() ) !== null ) {
				node = node[bit];
				if ( typeof node === 'number' ) return node;
				if ( typeof node !== 'object' ) throw "invalid huffman sequence";
			}
			return null;
		}
		
		function receive( length ) {
			var n = 0;
			while ( length > 0 ) {
				var bit = readBit();
				if ( bit === null ) return;
				n = ( n << 1 ) | bit;
				length--;
			}
			return n;
		}
		
		function receiveAndExtend( length ) {
			var n = receive( length );
			if ( n >= 1 << ( length - 1) ) return n;
			return n + ( -1 << length ) + 1;
		}
		
		function decodeBaseline( component, zz ) {
			var t = decodeHuffman( component.huffmanTableDC );
			var diff = t === 0 ? 0 : receiveAndExtend( t );
			zz[0] = ( component.pred += diff );
			var k = 1;
			while ( k < 64 ) {
				var rs = decodeHuffman( component.huffmanTableAC );
				var s = rs & 15, r = rs >> 4;
				if ( s === 0 ) {
					if (r < 15) break;
					k += 16;
					continue;
				}
				k += r;
				var z = dctZigZag[k];
				zz[z] = receiveAndExtend( s );
				k++;
			}
		}
		
		function decodeDCFirst( component, zz ) {
			var t = decodeHuffman( component.huffmanTableDC );
			var diff = ( t === 0 ) ? 0 : ( receiveAndExtend( t ) << successive );
			zz[0] = ( component.pred += diff );
		}
		
		function decodeDCSuccessive( component, zz ) {
			zz[0] |= readBit() << successive;
		}
		
		var eobrun = 0;
		function decodeACFirst( component, zz ) {
			if ( eobrun > 0 ) {
				eobrun--;
				return;
			}
			var k = spectralStart, e = spectralEnd;
			while ( k <= e ) {
				var rs = decodeHuffman( component.huffmanTableAC );
				var s = rs & 15, r = rs >> 4;
				if ( s === 0 ) {
					if ( r < 15 ) {
						eobrun = receive( r ) + ( 1 << r ) - 1;
						break;
					}
					k += 16;
					continue;
				}
				k += r;
				var z = dctZigZag[k];
				zz[z] = receiveAndExtend( s ) * ( 1 << successive );
				k++;
			}
		}
		
		var successiveACState = 0, successiveACNextValue;
		function decodeACSuccessive( component, zz ) {
			var k = spectralStart, e = spectralEnd, r = 0;
			while ( k <= e ) {
				var z = dctZigZag[k];
				switch ( successiveACState ) {
					case 0: // initial state
						var rs = decodeHuffman( component.huffmanTableAC ),
							s = rs & 15;
						r = rs >> 4;
						if ( s === 0 ) {
							if ( r < 15 ) {
								eobrun = receive( r ) + ( 1 << r );
								successiveACState = 4;
							} else {
								r = 16;
								successiveACState = 1;
							}
						} else {
							if ( s !== 1 ) throw "invalid ACn encoding";
							successiveACNextValue = receiveAndExtend( s );
							successiveACState = r ? 2 : 3;
						}
						continue;
					case 1: // skipping r zero items
					case 2:
						if ( zz[z] ) {
							zz[z] += ( readBit() << successive );
						} else {
							r--;
							if ( r === 0 ) successiveACState = ( successiveACState == 2 ) ? 3 : 0;
						}
						break;
					case 3: // set value for a zero item
						if ( zz[z] ) {
							zz[z] += ( readBit() << successive );
						} else {
							zz[z] = successiveACNextValue << successive;
							successiveACState = 0;
						}
						break;
					case 4: // eob
						if ( zz[z] ) zz[z] += ( readBit() << successive );
						break;
				}
				k++;
			}
			
			if ( successiveACState === 4 ) {
				eobrun--;
				if ( eobrun === 0 ) successiveACState = 0;
			}
		}
		
		function decodeMcu( component, decode, mcu, row, col ) {
			var mcuRow = ( mcu / mcusPerLine ) | 0;
			var mcuCol = mcu % mcusPerLine;
			var blockRow = mcuRow * component.samplingVertical + row;
			var blockCol = mcuCol * component.samplingHorizontal + col;
			decode( component, component.blocks[blockRow][blockCol] );
		}
		
		function decodeBlock( component, decode, mcu ) {
			var blockRow = ( mcu / component.blocksPerLine ) | 0;
			var blockCol = mcu % component.blocksPerLine;
			decode( component, component.blocks[blockRow][blockCol] );
		}

		var componentsLength = components.length;
		var component, i, j, k, n;
		var decodeFn;
		if ( progressive ) {
			if ( spectralStart === 0 ) {
				decodeFn = ( successivePrev === 0 ) ? decodeDCFirst : decodeDCSuccessive;
			} else {
				decodeFn = ( successivePrev === 0 ) ? decodeACFirst : decodeACSuccessive;
			}
		} else {
			decodeFn = decodeBaseline;
		}

		var mcu = 0, 
			marker,
			mcuExpected;
		if ( componentsLength == 1 ) {
			mcuExpected = components[0].blocksPerLine * components[0].blocksPerColumn;
		} else {
			mcuExpected = mcusPerLine * frame.mcusPerColumn;
		}
		if ( !resetInterval ) resetInterval = mcuExpected;

		var h, v;
		while ( mcu < mcuExpected ) {
			// reset interval stuff
			for ( i = 0; i < componentsLength; i++ ) {
				components[i].pred = 0;
			}
			eobrun = 0;

			if ( componentsLength == 1 ) {
				component = components[0];
				for ( n = 0; n < resetInterval; n++ ) {
					decodeBlock( component, decodeFn, mcu );
					mcu++;
				}
			} else {
				for ( n = 0; n < resetInterval; n++ ) {
					for ( i = 0; i < componentsLength; i++ ) {
						component = components[i];
						h = component.samplingHorizontal;
						v = component.samplingVertical;
						for ( j = 0; j < v; j++ ) {
							for ( k = 0; k < h; k++ ) {
								decodeMcu( component, decodeFn, mcu, j, k );
							}
						}
					}
					mcu++;

					// If we've reached our expected MCU's, stop decoding
					if ( mcu === mcuExpected ) {
						//trace('If we\'ve reached our expected MCU\'s, stop decoding');
						break;
					}
				}
			}

			// find marker
			bitsCount = 0;
			//marker = ( data[offset] << 8 ) | data[offset + 1];
			marker = ( file.getUint8At( offset ) << 8 ) | file.getUint8At( offset + 1 );
			
			if ( marker < 0xFF00 ) {
				throw "marker was not found";
			}

			if ( marker >= 0xFFD0 && marker <= 0xFFD7 ) { // RSTx
				trace( 'RST' + ( marker - 208 ), offset );
				//this.readRSTn( file, file.getUint8At( offset + 1 ) );
				offset += 2;
			} else {
				break;
			}
			
		}

		return offset - startOffset;
	}
	
	function prepareComponents( frame ) {
		var maxH = 0, maxV = 0;
		var component, componentId;
		for ( componentId in frame.components ) {
			if ( frame.components.hasOwnProperty( componentId ) ) {
				component = frame.components[componentId];
				if ( maxH < component.samplingHorizontal ) maxH = component.samplingHorizontal;
				if ( maxV < component.samplingVertical ) maxV = component.samplingVertical;
			}
		}
		var mcusPerLine = Math.ceil( frame.samplesPerLine / 8 / maxH );
		var mcusPerColumn = Math.ceil( frame.scanLines / 8 / maxV );
		for ( componentId in frame.components ) {
			if ( frame.components.hasOwnProperty( componentId ) ) {
				component = frame.components[componentId];
				var blocksPerLine = Math.ceil( Math.ceil( frame.samplesPerLine / 8 ) * component.samplingHorizontal / maxH );
				var blocksPerColumn = Math.ceil( Math.ceil( frame.scanLines / 8 ) * component.samplingVertical / maxV );
				var blocksPerLineForMcu = mcusPerLine * component.samplingHorizontal;
				var blocksPerColumnForMcu = mcusPerColumn * component.samplingVertical;
				var blocks = [];
				for ( var i = 0; i < blocksPerColumnForMcu; i++ ) {
					var row = [];
					for ( var j = 0; j < blocksPerLineForMcu; j++ ) {
						row.push( new Int32Array( 64 ) );
					}
					blocks.push( row );
				}
				component.blocksPerLine = blocksPerLine;
				component.blocksPerColumn = blocksPerColumn;
				component.blocks = blocks;
			}
		}
		frame.maxH = maxH;
		frame.maxV = maxV;
		frame.mcusPerLine = mcusPerLine;
		frame.mcusPerColumn = mcusPerColumn;
	}
	// / END / //
	
	
	return {
		name: 'JPEG Reader',
		version: '1.0.0',
		
		parse: function( file ) {
			var o = {
					segments: []
				},
				marker;

			marker = this.readSegmentHeader( file );
			while ( marker ) {
				o.segments.push( this.readSegment( file, marker ) );
				
				// End segment
				if ( file.getBytesAvailable() <= 0 ) break;
				if ( marker.type === 0xD9 ) break;
				
				// Next marker
				marker = this.readSegmentHeader( file );
			}
			
			return o;
		},
		
		readSegmentHeader: function( file/*:ByteArray */ ) {
			var markerPrefix = file.getUint8(),
				markerType = file.getUint8();
				
			if ( markerPrefix != 0xFF ) {
				if (debug) trace('Invalid JPEG marker 0x' + markerPrefix.toString(16).toUpperCase() );
				return false;
			}
			
			return { prefix: markerPrefix, type: markerType };
		},

		readSegment: function( file, marker ) {
			// Valid
			if ( marker && marker.prefix === 0xFF ) {
				trace('read segment 0x' + marker.type.toString(16).toUpperCase());
				switch( marker.type ) {
					// Start Of Frame markers, non-differential, Huffman coding
					case 0xC0 : // Baseline DCT
					case 0xC1 : // Extended Sequential DCT
					case 0xC2 : // Progressive DCT
					case 0xC3 : // Lossless (sequential)
					// Start Of Frame markers, differential, Huffman coding
					case 0xC5 : // Differential sequential DCT
					case 0xC6 : // Differential progressive DCT
					case 0xC7 : // Differential lossless (sequential)
					// Start Of Frame markers, non-differential, arithmetic coding
					case 0xC9 : // Extended Sequential DCT
					case 0xCA : // Progressive DCT
					case 0xCB : // Lossless (sequential)
					// Start Of Frame markers, differential, arithmetic coding
					case 0xCD : // Differential sequential DCT
					case 0xCE : // Differential progressive DCT
					case 0xCF : // Differential lossless (sequential)
						return this.readSOFn( file, marker.type );
					case 0xC4 : return this.readDHT( file ); // Define Huffman Table(s)
					//case 0xC8 : return this.readJPG( file ); break; // Reserved for JPEG extensions
					case 0xCC : return this.readDAC( file ); // Define arithmetic coding conditioning(s)
					case 0xD0 : 
					case 0xD1 : 
					case 0xD2 : 
					case 0xD3 : 
					case 0xD4 : 
					case 0xD5 : 
					case 0xD6 : 
					case 0xD7 : 
						return this.readRSTn( file, marker.type ); // Restart interval termination
					case 0xD8 : return this.readSOI( file ); // Start Of Image
					case 0xD9 : return this.readEOI( file ); // End Of Image
					case 0xDA : return this.readSOS( file ); // Start Of Scan
					case 0xDB : return this.readDQT( file ); // Define Quantization Table(s)
					case 0xDC : return this.readDNL( file ); // Define number of lines
					case 0xDD : return this.readDRI( file ); // Define Restart Interval
					case 0xDE : return this.readDHP( file, marker.type ); // Define hierarchical progression
					case 0xDF : return this.readEXP( file ); // Expand reference component(s)
					// Reserved for application segments
					case 0xE0 :
					case 0xE1 : 
					case 0xE2 : 
					case 0xE3 : 
					case 0xE4 : 
					case 0xE5 : 
					case 0xE6 : 
					case 0xE7 : 
					case 0xE8 : 
					case 0xE9 : 
					case 0xEA : 
					case 0xEB : 
					case 0xEC : 
					case 0xED : 
					case 0xEE : 
					case 0xEF : 
						return this.readAPPn( file, marker.type ); // Reserved for application segments
					case 0xF0 :
					case 0xF1 : 
					case 0xF2 : 
					case 0xF3 : 
					case 0xF4 : 
					case 0xF5 : 
					case 0xF6 : 
					case 0xF7 : 
					case 0xF8 : 
					case 0xF9 : 
					case 0xFA : 
					case 0xFB : 
					case 0xFC : 
					case 0xFD : 
						return this.readJPGn( file, marker.type ); // Reserved for JPEG extensions
					case 0xFE : return this.readCOM( file ); // Comment
					case 0x01 : return this.readTEM( file ); // For temporary private use in arithmetic coding
					// case 0x02 - 0xBF // Reserved
				}
			}
			
			// Invalid
			return null;
		},
		
		readSOFn: function( file, markerType ) {
			var o = {},
				componentCount,
				sofNum = markerType - 192,
				i;
			
			o.length = file.getUint16();
			o.type = 'SOF' + sofNum;
			o.extended = ( markerType === 0xC1 );
			o.progressive = ( markerType === 0xC2 );
			
			o.precision = file.getUint8(); // This is in bits/sample, usually 8 (12 and 16 not supported by most software). 
			o.height = o.scanLines = file.getUint16();
			o.width = o.samplesPerLine = file.getUint16();
			o.components = [];
			
			componentCount = file.getUint8(); // Usually 1 = grey scaled, 3 = color YcbCr or YIQ 4 = color CMYK
			switch ( componentCount ) {
				case 1: o.componentCountLabel = 'Grey Scaled'; break;
				case 3: o.componentCountLabel = 'Color YcbCr/YIQ'; break;
				case 4: o.componentCountLabel = 'Color CMYK'; break;
				default: o.componentCountLabel = 'Unknown';
			}
			
			// Read each component data of 3 bytes
			for ( i = 0; i < componentCount; i++ ) {
				var component = {}, samplingFactor;
				// 1 = Y, 2 = Cb, 3 = Cr, 4 = I, 5 = Q
				component.index = file.getUint8();
				
				// bit 0-3 vertical., 4-7 horizontal
				samplingFactor = file.getUint8();
				component.samplingHorizontal = samplingFactor >> 4;
				component.samplingVertical = samplingFactor & 15;
				component.quantizationTableId = file.getUint8();
				
				o.components.push( component );
			}
			
			prepareComponents( o );
			frame = o;
			frames.push(o);
			return o;
		},
		
		readDHT: function( file ) {
			var o = {},
				endPosition,
				i;
				
			o.length = file.getUint16();
			o.type = 'DHT';
			o.huffmanTables = [];
			
			endPosition = file.position + o.length - 2;
			//while( file.position < endPosition ) {
			for ( i = 2; i < o.length;) {
				var ht = {},
					htInfo = file.getUint8(),
					// bit 4 0 = DC table, 1 = AC table
					htClass = htInfo >> 4,
					// bit 0-3 : Huffman table destination identifier
					htIndex = htInfo & 15,
					//symbolLengths = [],
					symbolValues,
					symbolLengths = new Uint8Array( 16 ),
					symbolLengthSum = 0,
					j;
				
				ht.tableClass = htClass;
				ht.tableClassLabel = ( htClass === 0 ) ? 'DC Table' : 'AC Table';
				
				// Symbol Lengths
				for ( j = 0; j < 16; j++ ) {
					symbolLengthSum += ( symbolLengths[j] = file.getUint8() );
				}
				
				// Symbol Values
				/*ht.symbols = [];
				for ( j = 0; j < 16; j++ ) {
					ht.symbols.push( file.getBytes( symbolLengths[j] ) );
				}*/
				symbolValues = new Uint8Array( symbolLengthSum );
				for ( j = 0; j < symbolLengthSum; j++ ) {
					symbolValues[j] = file.getByte();
				}
				
				i += 17 + symbolLengthSum;
				
				if ( htClass === 0 ) {
					ht.table = huffmanTablesDC[htIndex] = buildHuffmanTable( symbolLengths, symbolValues );
				} else {
					ht.table = huffmanTablesAC[htIndex] = buildHuffmanTable( symbolLengths, symbolValues );
				}
				
				o.huffmanTables[htIndex] = ht;
			}
			
			return o;
		},
		
		readJPG: function( file ) {
			// Reserved
			return { type:'JPG' };
		},
		
		readDAC: function( file ) {
			var o = {},
				endPosition;
			
			o.length = file.getUint16();
			o.type = 'DAC';
			o.conditioningParamaters = [];
			
			endPosition = file.position + o.length - 2;
			while( file.position < endPosition ) {
				var param = {},
					ctInfo = file.getUint8(), // Arithmetic coding conditioning table info
					// bit 4 0 = DC table, 1 = AC table
					ctClass = ctInfo >> 4,
					// bit 0-3 : Huffman table destination identifier
					ctIndex = ctInfo & 15,
					symbolLengths = [],
					i;
				
				param.tableClass = ctClass;
				param.tableClassLabel = ( ctClass === 0 ) ? 'DC Table' : 'AC Table';
				param.valueIndex = file.getUint8(); // value = dcTable[valueIndex] or acTable[valueIndex]
				
				o.conditioningParamaters.push( param );
			}
			
			return o;
		},
		
		readRSTn: function( file, markerType ) {
			// 0-7 markers
			return { type: 'RST' + ( markerType - 208 ) };
		},
		
		readSOI: function( file ) {
			// No payload
			return { type:'SOI' };
		},
		
		readEOI: function( file ) {
			return { type:'EOI' };
		},
		
		readSOS: function( file ) {
			var o = {},
				componentCount,
				components = [],
				successiveApproximation,
				i;
				
			o.length = file.getUint16();
			o.type = 'SOS';
			componentCount = file.getUint8();
			//o.components = [];
			
			// Read each component
			for ( i = 0; i < componentCount; i++ ) {
				var component = {},
					huffmanTable;
					
				// 1 = Y, 2 = Cb, 3 = Cr, 4 = I, 5 = Q
				//component.index = file.getUint8();
				var componentIndex = file.getUint8();
				component = frame.components[componentIndex - 1];
				
				huffmanTable = file.getUint8();
				component.huffmanTableDCIndex = huffmanTable >> 4; // index
				component.huffmanTableACIndex = huffmanTable & 15; // index
				component.huffmanTableDC = huffmanTablesDC[huffmanTable >> 4];
				component.huffmanTableAC = huffmanTablesAC[huffmanTable & 15];
				
				components.push( component );
			}
			
			o.spectralStart = file.getUint8();
			o.spectralEnd = file.getUint8();
			successiveApproximation = file.getUint8();
			o.successiveApproximationHigh = successiveApproximation >> 4;
			o.successiveApproximationLow = successiveApproximation & 15;
			
			var processed = decodeScan( file, file.position, frame, components, resetInterval, o.spectralStart, o.spectralEnd, o.successiveApproximationHigh, o.successiveApproximationLow );
			file.position += processed;
			
			return o;
		},
		
		readDQT: function( file ) {
			var o = {},
				endPosition;
				
			o.length = file.getUint16();
			o.type = 'DQT';
			o.quantizationTables = [];
			
			endPosition = file.position + o.length - 2;
			while( file.position < endPosition ) {
				var qt = {},
					qtInfo = file.getUint8(),
					// bit 4..7: precision of QT, 0 = 8 bit, otherwise 16 bit
					qtPrecision = qtInfo >> 4,
					//  bit 0..3: number of QT (0..3, otherwise error)
					qtIndex = qtInfo & 15;
				
				qt.precision = qtPrecision;
				qt.precisionLabel = ( qtPrecision === 0 ) ? '8 bit' : '16 bit';
				qt.elements = file.getBytes( 64 * ( qtPrecision + 1 ) );
				
				o.quantizationTables[qtIndex] = qt;
			}
			
			return o;
		},
		
		readDNL: function( file ) {
			var o = {};
			
			o.length = file.getUint16();
			o.type = 'DNL';
			o.numberOfLines = file.getUint16();
			
			return o;
		},
		
		readDRI: function( file ) {
			var o = {};
			
			o.length = file.getUint16();
			o.type = 'DRI';
			o.restartInterval = resetInterval = file.getUint16();
			
			return o;
		},
		
		readDHP: function( file, markerType ) {
			var o = {},
				componentCount,
				i;
			
			o.length = file.getUint16();
			o.type = 'DHP';
			o.extended = ( markerType === 0xC1 );
			o.progressive = ( markerType === 0xC2 );
			
			o.precision = file.getUint8(); // This is in bits/sample, usually 8 (12 and 16 not supported by most software). 
			o.height = o.scanLines = file.getUint16();
			o.width = o.samplesPerLine = file.getUint16();
			o.components = [];
			
			componentCount = file.getUint8(); // Usually 1 = grey scaled, 3 = color YcbCr or YIQ 4 = color CMYK
			switch ( componentCount ) {
				case 1: o.componentCountLabel = 'Grey Scaled'; break;
				case 3: o.componentCountLabel = 'Color YcbCr/YIQ'; break;
				case 4: o.componentCountLabel = 'Color CMYK'; break;
				default: o.componentCountLabel = 'Unknown';
			}
			
			// Read each component data of 3 bytes
			for ( i = 0; i < o.componentCount; i++ ) {
				var component = {}, samplingFactor;
				// 1 = Y, 2 = Cb, 3 = Cr, 4 = I, 5 = Q
				component.index = file.getUint8();
				
				// bit 0-3 vertical., 4-7 horizontal
				samplingFactor = file.getUint8();
				component.samplingHorizontal = samplingFactor >> 4;
				component.samplingVertical = samplingFactor & 15;
				component.quantizationTableId = file.getUint8();
				
				o.components.push( component );
			}
			
			return o;
		},
		
		// The EXP segment shall be present if (and only
		// if) expansion of the reference components is required either 
		// horizontally or vertically
		readEXP: function( file ) {
			var o = {},
				expansion;
			
			o.length = file.getUint16();
			o.type = 'EXP';
			
			// Both Eh and Ev shall be one if expansion is required both horizontally and vertically.
			expansion = file.getUint8();
			// If one, the reference components shall be expanded horizontally by a 
			// factor of two. If horizontal expansion is not required, the value shall be zero.
			o.expandHorizontally = expansion >> 4;
			// If one, the reference components shall be expanded vertically by a 
			// factor of two. If vertical expansion is not required, the value shall be zero.
			o.expandVertically = expansion & 15;
			
			return o;
		},
		
		readAPPn: function( file, markerType ) {
			var o = {},
				appNum = markerType - 224;
				
			o.length = file.getUint16();
			o.type = 'APP' + appNum;
			
			// Peak at identifier
			var pos = file.position,
				identifier = file.getUTFBytes( 4 );
			file.position = pos;
			
			switch ( appNum ) {
				case 0 :
					switch ( identifier ) {
						case "JFIF":
							o = JFIFReader.parse( file, o );
							break;
						case "JFXX":
							o = JFXXReader.parse( file, o );
							break;
						//case "CIFF": // Camera Image File Format (Canon)
						case "AVI1":
							o = AVI1Reader.parse( file, o );
							break;
						case "Ocad": // Photobucket Ocad
							o = OcadReader.parse( file, o );
							break;
						default:
							o.data = file.getBytes( o.length - 2 );
					}
					break;
				case 1 :
					switch ( identifier ) {
						case "Exif":
							o = EXIFReader.parse( file, o );
							break;
						case "XMP": // Extensible Metadata Platform
							/* falls through */
						case "QVCI": // Casio QV-7000SX QVCI information
							/* falls through */
						case "FLIR": // FLIR thermal imaging data
							/* falls through */
						default:
							o.data = file.getBytes( o.length - 2 );
					}
					break;
				case 2 :
					switch ( identifier ) {
						case "ICC": // International Color Consortium
							/* falls through */
						case "FPXR": // FlashPix Ready
							/* falls through */
						case "MPF": // Multi-Picture Format
							/* falls through */
						case "PreviewImage": // Samsung/GE APP2 preview image (multi-segment)
							/* falls through */
						default:
							o.data = file.getBytes( o.length - 2 );
					}
					break;
				case 3 :
					switch ( identifier ) {
						case "Kodak Meta": // Kodak Meta information (EXIF-like)
							/* falls through */
						case "Stim": // Stereo Still Image format
							/* falls through */
						case "PreviewImage": // Samsung/HP preview image (multi-segment)
							/* falls through */
						default:
							o.data = file.getBytes( o.length - 2 );
					}
					break;
				case 4 :
					switch ( identifier ) {
						case "Scalado": // (presumably written by Scalado mobile software)
							/* falls through */
						case "FPXR": // FlashPix Ready in non-standard location (multi-segment)
							/* falls through */
						case "PreviewImage": // (continued from APP3)
							/* falls through */
						default:
							o.data = file.getBytes( o.length - 2 );
					}
					break;
				case 5 :
					switch ( identifier ) {
						case "Ricoh RMETA": // Ricoh custom fields
							/* falls through */
						case "PreviewImage": // (continued from APP4)
							/* falls through */
						default:
							o.data = file.getBytes( o.length - 2 );
					}
					break;
				case 6 :
					switch ( identifier ) {
						case "EPPIM": // Toshiba PrintIM
							/* falls through */
						case "NITF": // National Imagery Transmission Format
							/* falls through */
						case "HP TDHD": // Hewlett-Packard Photosmart R837 TDHD information
							/* falls through */
						default:
							o.data = file.getBytes( o.length - 2 );
					}
					break;
				case 7 :
					switch ( identifier ) {
						case "Pentax": // Pentax APP7 maker notes
							/* falls through */
						case "Qualcomm": // Qualcomm Camera Attributes
							/* falls through */
						default:
							o.data = file.getBytes( o.length - 2 );
					}
					break;
				case 8 :
					switch ( identifier ) {
						case "SPIFF": // Still Picture Interchange File Format
							/* falls through */
						default:
							o.data = file.getBytes( o.length - 2 );
					}
					break;
				case 9 :
					switch ( identifier ) {
						case "Media Jukebox": // Media Jukebox XML information
							/* falls through */
						default:
							o.data = file.getBytes( o.length - 2 );
					}
					break;
				case 10 :
					switch ( identifier ) {
						case "Comment": // PhotoStudio Unicode Comment
							/* falls through */
						default:
							o.data = file.getBytes( o.length - 2 );
					}
					break;
				case 11 :
					switch ( identifier ) {
						case "JPEG-HDR": // JPEG-HDR compressed ratio image
							/* falls through */
						default:
							o.data = file.getBytes( o.length - 2 );
					}
					break;
				case 12 :
					switch ( identifier ) {
						case "Picture Info": // ASCII-based Picture Information
							/* falls through */
						case "Ducky": // Photoshop "Save for Web"
							/* falls through */
						default:
							o.data = file.getBytes( o.length - 2 );
					}
					break;
				case 13 :
					switch ( identifier ) {
						case "Photoshop IRB": // Image Resource Block (multi-segment, includes IPTC)
							/* falls through */
						case "Adobe CM": // Adobe Color Management
							/* falls through */
						default:
							o.data = file.getBytes( o.length - 2 );
					}
					break;
				case 14 :
					switch ( identifier ) {
						case "Adobe":
							o = AdobeReader.parse( file, o );
							break;
						default:
							o.data = file.getBytes( o.length - 2 );
					}
					break;
				case 15 :
					switch ( identifier ) {
						case "GraphicConverter": // GraphicConverter quality
							/* falls through */
						default:
							o.data = file.getBytes( o.length - 2 );
					}
					break;
				default :
					o.data = file.getBytes( o.length - 2 );
			}
			
			return o;
		},
		
		readJPGn: function( file ) {
			// reserved
			return { type:'JPGn' };
		},
		
		readCOM: function( file ) {
			var o = {};
			o.length = file.getUint16();
			o.type = 'COM';
			o.comment = file.getUTFBytes( o.length - 2 );
			return o;
		},
		
		readTEM: function( file ) {
			return { type:'TEM' };
		}
	};
})();

// Parse the individual file
onmessage = function( event ) {
	var id = event.data.fileID,
		file = new ByteArray( event.data.text, ByteArray.BIG_ENDIAN ),
		data = JPEGReader.parse( file );
		
	postMessage( { fileID: id, data: data } );
};