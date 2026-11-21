// Typical build-cost split by procurement package, per project type (owner 2026-11-21: "先做A" - deep cards show what a project buys).
// Every share comes from a published report that was opened and read (2026-11-21); percentages computed from the report's own US$ figures
// where it prints dollars, rounded to whole %. Shares are the industry's typical split, never a claim about one project's contracts.
// Add a type only with a source; a project type without a row simply does not get this chart.
export const CAPEX_REF = {
  datacenter: {
    label: 'Data centre (air-cooled)',
    match: /data ?cent/i,
    not: /power plant|gas|solar|wind/i,
    // Turner & Townsend, Data Centre Construction Cost Index 2025, "Data centre construction cost trends" (read via Wayback copy 2025-12-11):
    // "indicative average percentage allocation of construction costs ... in the US"; excludes land, utility works, site works, IT equipment, fees
    packages: [
      { name: 'Electrical, incl. equipment', share: 54 },
      { name: 'Mechanical and cooling, incl. equipment', share: 22 },
      { name: 'Building shell and architecture', share: 14 },
      { name: 'Contractor costs and fees', share: 10 },
    ],
    source: 'Turner & Townsend, Data Centre Construction Cost Index 2025 (US, air-cooled; excludes land, IT equipment and fees)',
  },
  offshorewind: {
    label: 'Offshore wind farm (fixed-bottom)',
    match: /offshore wind/i,
    not: /vessel|ship|ctv|crew transfer|port|cable laying/i,
    // NREL, Cost of Wind Energy Review 2024 Edition (NREL/PR-5000-91775), slide 37, total CapEx 5,411 2023$/kW
    packages: [
      { name: 'Wind turbines', share: 33 },
      { name: 'Finance, insurance, contingency', share: 19 },
      { name: 'Installation at sea', share: 15 },
      { name: 'Foundations and scour protection', share: 15 },
      { name: 'Array and export cables', share: 9 },
      { name: 'Development and seabed lease', share: 5 },
      { name: 'Offshore substation', share: 4 },
    ],
    source: 'NREL, Cost of Wind Energy Review 2024 (US fixed-bottom reference project)',
  },
  bess: {
    label: 'Battery storage (lithium iron phosphate)',
    match: /battery|\bbess\b|energy storage/i,
    not: /solar|wind|gas|factory|gigafactory|cell plant|manufactur|recycl/i,
    // PNNL, 2022 Grid Energy Storage Technology Cost and Performance Assessment (PNNL-33283), Fig. 4.3, 10 MW / 4 h, 2021 costs, total $410.70/kWh
    packages: [
      { name: 'Battery modules', share: 42 },
      { name: 'Project development', share: 16 },
      { name: 'Engineering and construction', share: 14 },
      { name: 'Systems integration', share: 11 },
      { name: 'Racks, containers, cooling', share: 10 },
      { name: 'Inverters and controls', share: 5 },
      { name: 'Grid connection', share: 2 },
    ],
    source: 'PNNL, Grid Energy Storage Cost and Performance Assessment 2022 (10 MW / 4 h, 2021 prices; battery share has fallen since)',
  },
  electrolyser: {
    label: 'PEM electrolyser system (equipment only)',
    match: /electroly|green hydrogen/i,
    not: /ammonia|methanol|refuel|pipeline|factory|gigafactory|manufactur/i,
    // IRENA, Green Hydrogen Cost Reduction (2020), Fig. 18, 1 MW PEM: stack 45% / balance of plant 55%, shares of the whole system computed
    packages: [
      { name: 'Power supply (rectifier)', share: 27 },
      { name: 'Bipolar plates', share: 24 },
      { name: 'Water circulation', share: 12 },
      { name: 'Hydrogen processing', share: 11 },
      { name: 'Catalyst-coated membrane', share: 11 },
      { name: 'Porous transport layer', share: 8 },
      { name: 'Cooling, small parts, assembly', share: 7 },
    ],
    source: 'IRENA, Green Hydrogen Cost Reduction, 2020 (1 MW PEM system; equipment only, no installation or civil works)',
  },
  desal: {
    label: 'Seawater reverse-osmosis plant',
    match: /desalin|reverse osmosis|\bswro\b/i,
    not: /pipeline|transfer|conveyor/i,
    // Danfoss, "Understanding the cost drivers of SWRO" (AC391840501087en-000101, Sept 2021), p. 3 chart "average total CAPEX"; 14 labels grouped
    packages: [
      { name: 'Equipment, piping, controls', share: 26 },
      { name: 'Civil works', share: 19 },
      { name: 'Design, permits, legal', share: 17 },
      { name: 'Seawater intake and outfall', share: 11 },
      { name: 'Membranes, pumps, energy recovery', share: 10 },
      { name: 'Installation', share: 9 },
      { name: 'Pretreatment', share: 8 },
    ],
    source: 'Danfoss (pump and energy-recovery maker), Understanding the cost drivers of SWRO, 2021',
  },
  ccgt: {
    label: 'Combined-cycle gas power plant',
    match: /combined.cycle|\bccgt\b|gas.fired power|gas power plant|gas plant\b/i,
    not: /battery|bess|storage|data cent/i,
    // EIA / Sargent & Lundy, Capital Cost and Performance Characteristics (Jan 2024, AEO2025), Table 6-1 Case 6, CC 1x1x1 H-class 627 MW, total US$577.4m
    packages: [
      { name: 'Gas turbine, HRSG and steam turbine', share: 27 },
      { name: 'Construction labour', share: 18 },
      { name: 'EPC fee and contingency', share: 16 },
      { name: 'Pumps, cooling, transformers, switchgear', share: 14 },
      { name: "Owner's costs, grid and gas connection", share: 11 },   // 10.5% rounds up, so the split adds to 100
      { name: 'Construction materials', share: 8 },
      { name: 'Engineering and commissioning', share: 6 },
    ],
    unit: { range: 'US$870–920/kW', label: 'typical build cost per kW, US 2023 (EIA)' },
    source: 'US EIA / Sargent & Lundy, Capital Cost and Performance Characteristics, Jan 2024 (627 MW H-class case)',
  },
  pv: {
    label: 'Utility-scale solar PV',
    match: /solar|photovolt|\bpv\b/i,
    not: /battery|bess|storage|rooftop|module factory|manufactur/i,
    // NREL, U.S. Solar PV System and Energy Storage Cost Benchmarks Q1 2023 (NREL/TP-7A40-87303), Fig. 13 MMP PV-only, 100 MWdc tracker, US$1,161/kWdc
    packages: [
      { name: 'Solar modules', share: 32 },
      { name: 'Installation labour and equipment', share: 20 },
      { name: 'Electrical: cabling, substation, grid link', share: 15 },
      { name: 'Tax, contingency, overhead, profit', share: 12 },
      { name: 'Racking and trackers', share: 11 },
      { name: 'Engineering, permits, interconnection', share: 6 },
      { name: 'Inverters', share: 4 },
    ],
    unit: { range: 'US$1,160/kW', label: 'typical build cost per kW (DC), US 2023 (NREL)' },
    source: 'NREL, Solar PV and Storage Cost Benchmarks Q1 2023 (100 MW tracker plant)',
  },
  lng: {
    label: 'LNG liquefaction plant',
    match: /\blng\b|liquef/i,
    not: /regas|import terminal|fsru|carrier|heating unit|bunker|truck/i,
    // OIES, Songhurst, LNG Plant Cost Escalation (NG 83, Feb 2014), Figure 7 Cost Breakdown by Plant Area; owner's costs not included
    packages: [
      { name: 'Liquefaction and refrigeration', share: 42 },
      { name: 'Storage tanks, jetty and flare', share: 27 },
      { name: 'Utilities: power, water, steam', share: 20 },
      { name: 'Gas treatment and fractionation', share: 10 },
      { name: 'Site preparation', share: 1 },
    ],
    unit: { range: 'US$600–1,400/tpa', label: 'typical cost per tonne a year of capacity (OIES 2018)' },
    source: "Oxford Institute for Energy Studies, LNG Plant Cost Escalation, 2014 (plant areas; owner's costs excluded)",
  },
};
CAPEX_REF.wind = {
  label: 'Onshore wind farm',
  match: /\bwind\b/i,
  not: /offshore|vessel|ship|ctv|crew transfer|solar|tower factory|blade factory|manufactur/i,
  // NREL, Cost of Wind Energy Review 2024 Edition, slide 28 / appendix 61-62, land-based reference, total CapEx 1,968 2023$/kW
  packages: [
    { name: 'Turbines, incl. towers', share: 55 },
    { name: 'Finance, contingency, warranty', share: 15 },
    { name: 'Turbine transport', share: 10 },
    { name: 'Foundations', share: 6 },
    { name: 'Assembly and installation', share: 5 },
    { name: 'Engineering, roads, site works', share: 5 },
    { name: 'Electrical', share: 4 },
  ],
  source: 'NREL, Cost of Wind Energy Review 2024 (US land-based reference project)',
};
export function refFor(f) {
  // "battery-grade lithium carbonate" is a lithium plant, not battery storage
  const t = `${f.subsector || ''} ${f.name || ''} ${f.capacity || ''}`.replace(/battery[- ]grade/gi, '');
  for (const [key, r] of Object.entries(CAPEX_REF)) if (r.match.test(t) && !r.not.test(t)) return { key, ...r };
  return null;
}
