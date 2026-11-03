// AVI1
// JPEG AVI (http://www.schnarff.com/file-formats/bmp/BMPDIB.TXT)
var AVI1Reader = (function() {
	return {
		name: 'AVI1 Reader',
		version: '1.0.0',
		
		parse: function( file, o ) {
			o = o || {};
			o.identifier = file.getASCIIBytes( 4 ); // AVI1
			
			// The next byte indicates which field the JPEG data was compressed from
			// and has an expected value of one for the first JPEG data segment and 
			// two for the second segment, indicating the ODD and EVEN fields respectively
			o.interleavedField = file.getByte();
			
			switch( o.interleavedField ) {
				case 0:
					o.interleavedFieldLabel = "Not Interleaved";
					break;
				case 1:
					o.interleavedFieldLabel = "Odd";
					break;
				case 2:
					o.interleavedFieldLabel = "Even";
					break;
			};
			
			// The remaining seven bytes are expected to be set to 0 and will be ignored by the codec.
			file.getBytes( 7 );
			
			return o;
		}
	};
}());