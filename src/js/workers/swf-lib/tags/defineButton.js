/*
The DefineButton tag defines a button character for later use by control tags such as PlaceObject.
The minimum file format version is SWF 1.
*/
function DefineButton(ba, obj) {
	this.header = new RecordHeader(ba);
	this.id = ba.readUI16();
	
	this.characters = [];
	do {
		var record = new ButtonRecord(ba, this.header.type);
		this.characters.push(record);
	} while (!(record.buttonStateHitTest || record.buttonStateDown || record.buttonStateOver || record.buttonStateUp));
	
	this.actions = [];
	var record = getActionRecord(ba);
	while (record) {
		this.actions.push(record);
		record = getActionRecord(ba);
	}
	
	this.actionscript = parseActions(this.actions); // *
};