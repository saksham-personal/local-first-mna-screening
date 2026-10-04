/** Prompt text is inserted into the draft, never sent without the analyst. */
export const promptTemplates = [
  {
    id: "business",
    title: "Describe a business",
    category: "Criteria",
    description: "Define the products, customers, and workflows to find.",
    text: "Find companies that provide [products or services] to [customers]. Include [relevant activities]. Exclude [activities outside the core business].",
  },
  {
    id: "examples",
    title: "Use company examples",
    category: "Criteria",
    description: "Add the examples that explain what a good target looks like.",
    text: "These are good examples: [company names and descriptions]. Look for companies with similar core products and customer workflows. The most important features are [features].",
  },
  {
    id: "pitchbook",
    title: "Add PitchBook data",
    category: "Company data",
    description: "Attach the mapping CSV and PitchBook workbooks.",
    text: "Populate PitchBook data from the attached mapping CSV and data workbooks. Show how many companies matched and which rows need review.",
  },
  {
    id: "rogo",
    title: "Add ROGO data",
    category: "Company data",
    description: "Attach workbooks with website-based company data.",
    text: "Populate ROGO data from the attached workbooks. Use company websites to match rows and show the import summary.",
  },
  {
    id: "research",
    title: "Prepare fit questions",
    category: "Research",
    description: "Draft the questions that would clarify business fit.",
    text: "Prepare Bing research questions based on the approved business criteria. Show the questions for my review before any searches run.",
  },
];
