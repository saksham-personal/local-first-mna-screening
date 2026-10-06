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

export function extractIntakeFieldsFromText(text: string): {
  fields: ExtractedIntakeFields;
  matched: string[];
};
