/**
 * Tiberian Dawn's houses and object types by number, as its source numbers them (HousesType, StructType, UnitType,
 * InfantryType and AircraftType in DEFINES.H; names and INI names from BDATA.CPP, UDATA.CPP, IDATA.CPP and AADATA.CPP,
 * in the source EA released for the Remastered Collection). Shared by the readers that name them: recordings and maps.
 */

/** HousesType (DEFINES.H). */
export const TD_HOUSES = ['GDI', 'Nod', 'Neutral', 'Special', 'Multiplayer 1', 'Multiplayer 2', 'Multiplayer 3', 'Multiplayer 4', 'Multiplayer 5', 'Multiplayer 6'];

/** What each object type number is (StructType, UnitType, InfantryType, AircraftType in DEFINES.H; names and INI names from BDATA.CPP and the rest). */
export const TD_BUILDINGS = [
    'Weapons Factory (WEAP)',
    'Guard Tower (GTWR)',
    'Advanced Guard Tower (ATWR)',
    'Obelisk of Light (OBLI)',
    'Communications Center (HQ)',
    'Gun Turret (GUN)',
    'Construction Yard (FACT)',
    'Tiberium Refinery (PROC)',
    'Tiberium Silo (SILO)',
    'Helipad (HPAD)',
    'SAM Site (SAM)',
    'Airstrip (AFLD)',
    'Power Plant (NUKE)',
    'Advanced Power Plant (NUK2)',
    'Hospital (HOSP)',
    'Barracks (PYLE)',
    'ARCO',
    'Repair Facility (FIX)',
    'Bio-Research Laboratory (BIO)',
    'Hand of Nod (HAND)',
    'Temple of Nod (TMPL)',
    'Advanced Communications Center (EYE)',
    'MISS',
    ...Array.from({ length: 37 }, (_, i) => `Civilian building (V${String(i + 1).padStart(2, '0')})`),
    'Sandbags (SBAG)',
    'Chain-link fence (CYCL)',
    'Concrete wall (BRIK)',
    'Barbed wire (BARB)',
    'Wooden fence (WOOD)',
];
export const TD_VEHICLES = [
    'Mammoth Tank (HTNK)',
    'Medium Tank (MTNK)',
    'Light Tank (LTNK)',
    'Stealth Tank (STNK)',
    'Flame Tank (FTNK)',
    'Visceroid (VICE)',
    'APC (APC)',
    'Rocket Launcher (MSAM)',
    'Hum-Vee (JEEP)',
    'Nod Buggy (BGGY)',
    'Harvester (HARV)',
    'Artillery (ARTY)',
    'SSM Launcher (MLRS)',
    'Hovercraft (LST)',
    'Mobile HQ (MHQ)',
    'Gunboat (BOAT)',
    'Mobile Construction Vehicle (MCV)',
    'Recon Bike (BIKE)',
    'Triceratops (TRIC)',
    'Tyrannosaurus (TREX)',
    'Velociraptor (RAPT)',
    'Stegosaurus (STEG)',
];
export const TD_INFANTRY = [
    'Minigunner (E1)',
    'Grenadier (E2)',
    'Rocket Soldier (E3)',
    'Flamethrower (E4)',
    'Chem Warrior (E5)',
    'Engineer (E6)',
    'Commando (RMBO)',
    ...Array.from({ length: 10 }, (_, i) => `Civilian (C${i + 1})`),
    'Dr. Moebius (MOEBIUS)',
    'Delphi (DELPHI)',
    'Dr. Chan (CHAN)',
];
export const TD_AIRCRAFT = ['Transport Helicopter (TRAN)', 'A-10 (A10)', 'Apache (HELI)', 'C-17 (C17)', 'Orca (ORCA)'];
