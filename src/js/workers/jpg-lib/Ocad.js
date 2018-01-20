// Photobucket Ocad
var OcadReader = (function() {
	return {
		name: 'AVI1 Reader',
		version: '1.0.0',
		
		parse: function( file, o ) {
			o = o || {};
			
			o.identifier = file.getASCIIBytes( 4 ); // Ocad
			var rawData = file.getASCIIBytes( o.length - 2 - 4 ),
				regex = /\$(\w+):([^\0\$]+)/g,
				arr = regex.exec( rawData );
			o.revision = arr[2].trim();
			
			return o;
		}
	};
}());