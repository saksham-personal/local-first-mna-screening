export type ExtractedIntakeFields = {
  submitterName?: string;
  dueDate?: string;
  seniorClientExecs?: string;
  sameAsSubmitter?: boolean;
  requestType?: string;
  industry?: string;
  sector?: string;
  subSector?: string;
  investmentThesis?: string;
  productsServices?: string;
  endMarkets?: string;
  sizeParameters?: string[];
  ownershipPreference?: string[];
  geographyFocus?: string[];
};

export const INDUSTRY_SECTORS: Record<string, string[]>;
export const REQUEST_TYPES: string[];
export const SIZE_OPTIONS: string[];
export const OWNERSHIP_OPTIONS: string[];
export const GEOGRAPHY_OPTIONS: string[];

export function extractIntakeFieldsFromText(text: string): {
  fields: ExtractedIntakeFields;
  matched: string[];
};
