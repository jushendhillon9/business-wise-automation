/**
 * Raw-shaped rows parsed from the two real BWI DFW production snapshot CSVs
 * (see data/private/bwi/README.md). Deliberately kept close to the source
 * export: every field is the trimmed, NULL/None-normalized string the CSV
 * gave us -- codes, ZIPs, SIC/NAICS, and other leading-zero-bearing fields
 * are never parsed into numbers here, so no leading zero is ever lost. Any
 * further normalization (site type, lifecycle status) happens downstream via
 * the existing src/bwi-codes.ts, not in this parsing layer.
 */
export type BwiSnapshotRecord = {
  bwiLocationId: string;
  companyName: string;
  alphaSort?: string;
  statusCode: string;
  statusDescription?: string;
  marketId?: string;
  marketName?: string;
  marketAbbreviation?: string;
  siteTypeCode?: string;
  siteTypeDescription?: string;
  address?: string;
  buildingNumber?: string;
  street?: string;
  suiteNumber?: string;
  city?: string;
  state?: string;
  zip?: string;
  zipPlus?: string;
  county?: string;
  phone?: string;
  website?: string;
  sic?: string;
  naics?: string;
  startYear?: string;
  siteSizeCode?: string;
  siteEmployeeCount?: string;
  companySizeCode?: string;
  numberOfSites?: string;
  buildingTypeCode?: string;
  addressTypeCode?: string;
  addressValidationCode?: string;
  latitude?: string;
  longitude?: string;
  enteredDate?: string;
  baseDate?: string;
  researchedDate?: string;
};

export type BwiSnapshotRelationship = {
  relationshipType: string;
  relationshipDescription?: string;
  parentBwiId: string;
  parentCompanyName?: string;
  parentAlphaSort?: string;
  parentIsFortune1000?: string;
  parentCity?: string;
  parentState?: string;
  parentCountry?: string;
  parentStockTicker?: string;
  childBwiId: string;
  childCompanyName?: string;
  childStatus?: string;
  childSiteType?: string;
  childMarketId?: string;
  childCity?: string;
  childState?: string;
};
