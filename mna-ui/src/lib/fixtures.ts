import type { Company, FunnelCounts } from './contracts';

/** Fictional example records. Search scores belong to their source only. */
export const companies: Company[] = [
  {
    pk: 'ECID-AX91-CID-AX91', ecid: 'ECID-AX91', cid: 'CID-AX91', name: 'Northstar Claims Cloud',
    website: 'https://northstarclaims.example', city: 'Hartford', state: 'CT', source: 'both',
    description: 'Cloud claims workflow and administration software for regional insurers.', midScore: 0.87, isccScore: 0.91, screeningScore: 9,
    signal: 'Strong signal', tags: ['claims', 'workflow', 'insurance SaaS'], pbId: 'PB-71001',
    pbWebsite: 'https://northstarclaims.example', linkedin: 'https://www.linkedin.com/company/northstar-claims-cloud/',
    rawMid: { 'Company Name': 'Northstar Claims Cloud', Website: 'https://northstarclaims.example', 'MID ECID': 'ECID-AX91', 'MID CID': 'CID-AX91', 'MID Revenue': 42 },
    rawIscc: { 'ISCC Name': 'Northstar Claims Cloud, Inc.', 'ISCC Website': 'https://northstarclaims.example', 'ISCC ID': 'ISCC-1001', 'ISCC Category': 'Claims software' },
  },
  {
    pk: 'ECID-BK22-X', ecid: 'ECID-BK22', cid: null, name: 'HarborPoint Policy Systems',
    website: 'https://harborpointpolicy.example', city: 'Boston', state: 'MA', source: 'MID',
    description: 'Policy administration tools for specialty property and casualty carriers.', midScore: 0.74, screeningScore: 9,
    signal: 'Strong signal', tags: ['policy administration', 'P&C', 'core systems'], pbId: 'PB-71002',
    pbWebsite: 'https://harborpointpolicy.example', linkedin: 'https://www.linkedin.com/company/harborpoint-policy-systems/',
    rawMid: { 'Company Name': 'HarborPoint Policy Systems', Website: 'https://harborpointpolicy.example', 'MID ECID': 'ECID-BK22', 'MID CID': '', 'MID Employees': 185 },
  },
  {
    pk: 'X-CID-73Q', ecid: null, cid: 'CID-73Q', name: 'Juniper Risk Analytics',
    website: 'https://juniperrisk.example', city: 'Denver', state: 'CO', source: 'ISCC',
    description: 'Underwriting data and risk analytics platform for commercial insurers.', isccScore: 0.79, screeningScore: 6,
    signal: 'Strong signal', tags: ['underwriting', 'analytics', 'commercial lines'], pbId: 'PB-71003',
    pbWebsite: 'https://juniperrisk.example', linkedin: 'https://www.linkedin.com/company/juniper-risk-analytics/',
    rawIscc: { 'ISCC Name': 'Juniper Risk Analytics', 'ISCC Website': 'https://juniperrisk.example', 'ISCC ID': 'ISCC-1003', 'ISCC Legacy CID': 'X-CID-73Q' },
  },
  {
    pk: 'ECID-DM44-CID-DM44', ecid: 'ECID-DM44', cid: 'CID-DM44', name: 'Mosaic Reinsurance Tech',
    website: 'https://mosaicretech.example', city: 'Chicago', state: 'IL', source: 'both',
    description: 'Treaty and facultative reinsurance operations software.', midScore: 0.68, isccScore: 0.62, screeningScore: 7,
    signal: 'Worth exploring', tags: ['reinsurance', 'workflow', 'B2B software'], pbId: 'PB-71004',
    pbWebsite: 'https://mosaicretech.example', linkedin: 'https://www.linkedin.com/company/mosaic-reinsurance-tech/',
    rawMid: { 'Company Name': 'Mosaic Reinsurance Tech', Website: 'https://mosaicretech.example', 'MID ECID': 'ECID-DM44', 'MID CID': 'CID-DM44' },
    rawIscc: { 'ISCC Name': 'Mosaic Reinsurance Technologies', 'ISCC Website': 'https://mosaicretech.example', 'ISCC ID': 'ISCC-1004' },
  },
  {
    pk: 'ECID-EP58-X', ecid: 'ECID-EP58', cid: null, name: 'Cedar Mutual Operations',
    website: 'https://cedarmutualops.example', city: 'Columbus', state: 'OH', source: 'MID',
    description: 'Operations platform supporting policy servicing for mutual carriers.', midScore: 0.65, screeningScore: 8,
    signal: 'Worth exploring', tags: ['policy servicing', 'mutual insurers', 'operations'], pbId: 'PB-71005',
    pbWebsite: 'https://cedarmutualops.example', linkedin: 'https://www.linkedin.com/company/cedar-mutual-operations/',
    rawMid: { 'Company Name': 'Cedar Mutual Operations', Website: 'https://cedarmutualops.example', 'MID ECID': 'ECID-EP58', 'MID CID': '', 'MID Status': 'Provisional' },
  },
  {
    pk: 'X-CID-FR60', ecid: null, cid: 'CID-FR60', name: 'BluePeak Broker Exchange',
    website: 'https://bluepeakexchange.example', city: 'Austin', state: 'TX', source: 'ISCC',
    description: 'Digital distribution and broker connectivity software for insurers.', isccScore: 0.50, screeningScore: 3,
    signal: 'Worth exploring', tags: ['distribution', 'brokers', 'connectivity'], pbId: 'PB-71006',
    pbWebsite: 'https://bluepeakexchange.example', linkedin: 'https://www.linkedin.com/company/bluepeak-broker-exchange/',
    rawIscc: { 'ISCC Name': 'BluePeak Broker Exchange', 'ISCC Website': 'https://bluepeakexchange.example', 'ISCC ID': 'ISCC-1006', 'ISCC CID': 'CID-FR60' },
  },
  {
    pk: 'ECID-GT77-CID-GT77', ecid: 'ECID-GT77', cid: 'CID-GT77', name: 'Silverline Compliance Works',
    website: 'https://silverlinecompliance.example', city: 'New York', state: 'NY', source: 'both',
    description: 'Regulatory reporting and compliance case management for insurance groups.', midScore: 0.58, isccScore: 0.41, screeningScore: 4,
    signal: 'Needs research', tags: ['compliance', 'regulatory reporting', 'case management'], pbId: 'PB-71007',
    pbWebsite: 'https://silverlinecompliance.example', linkedin: 'https://www.linkedin.com/company/silverline-compliance-works/',
    rawMid: { 'Company Name': 'Silverline Compliance Works', Website: 'https://silverlinecompliance.example', 'MID ECID': 'ECID-GT77', 'MID CID': 'CID-GT77' },
    rawIscc: { 'ISCC Name': 'Silverline Compliance Works LLC', 'ISCC Website': 'https://silverlinecompliance.example', 'ISCC ID': 'ISCC-1007' },
  },
  {
    pk: 'ECID-HV88-X', ecid: 'ECID-HV88', cid: null, name: 'Fieldstone Insurance Data',
    website: 'https://fieldstoneinsdata.example', city: 'Minneapolis', state: 'MN', source: 'MID',
    description: 'Data quality and portfolio reporting tools for insurance teams.', midScore: 0.52, screeningScore: 5,
    signal: 'Needs research', tags: ['insurance data', 'portfolio reporting', 'data quality'], pbId: 'PB-71008',
    pbWebsite: 'https://fieldstoneinsdata.example', linkedin: 'https://www.linkedin.com/company/fieldstone-insurance-data/',
    rawMid: { 'Company Name': 'Fieldstone Insurance Data', Website: 'https://fieldstoneinsdata.example', 'MID ECID': 'ECID-HV88', 'MID CID': '', 'MID Segment': 'Data services' },
  },
];

export const initialCounts: FunnelCounts = { midOnly: 3, isccOnly: 2, both: 3 };
