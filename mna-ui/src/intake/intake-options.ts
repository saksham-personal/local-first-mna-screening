export const INDUSTRY_SECTORS: Record<string, string[]> = {
  "Technology, Media, & Telecommunications": [
    "Technology",
    "Media",
    "Communications",
  ],
  "Consumer/Retail": [
    "Retail Industries",
    "Consumer",
    "C&R Business Services",
    "Business Services",
  ],
  Diversified: [
    "Aerospace & Defense",
    "Automotive",
    "Basic Materials",
    "Capital Goods & Other",
    "Chemicals",
    "Metals",
    "Transportation",
  ],
  "Financial Institutions Group": ["Insurance", "Specialty finance"],
  "Energy/Power & Renewables/Mining": ["Energy", "Mining", "Power & Renewables"],
  Healthcare: [
    "Biotech/Pharma",
    "Healthcare Services",
    "Life Science tools & diagnostics",
    "Medical Devices",
    "Pharmaceuticals",
  ],
  "Unassigned Industry": ["Unassigned Industry"],
};

export const REQUEST_TYPES = [
  "New Platform (Sponsor / Family Office)",
  "Add-on (Sponsor / Family Office)",
  "Acquisitive Strategic Client (non-Sponsor)",
  "General Industry Screen",
];

export const SIZE_OPTIONS = [
  "$0 - 50MM",
  "$50MM - 100MM",
  "$100MM - 250MM",
  "$250MM - 500MM",
  "$500MM+",
];

export const OWNERSHIP_OPTIONS = [
  "Non-sponsor owned / Family or founder owned",
  "Sponsor owned",
  "VC-backed",
];

export const GEOGRAPHY_OPTIONS = ["US - All regions", "Canada"];
