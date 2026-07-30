/**
 * =============================================================================
 * TLDR-G VISUAL DEMO — CORPUS PROSE
 * =============================================================================
 *
 * Deterministic text generation for a synthetic NORDIC ENERGY-INFRASTRUCTURE
 * INTELLIGENCE corpus: grid operators, battery storage, permits, offtake
 * agreements, corporate holdings, materials supply, incident reports, board
 * minutes, technical papers.
 *
 * THE RULE THAT GOVERNS THIS FILE: no lorem ipsum, ever. A reader who descends
 * to the passage rung must land on prose that is actually about something. The
 * whole product claims the interface never lies about the engine; filler text
 * under a verbatim badge is exactly that lie, in miniature.
 *
 * Everything here is a pure function of a caller-supplied seeded stream. There
 * is no Math.random(), no Date.now(), no module-scope randomness. Two runs
 * produce byte-identical prose, which is what makes the content hashes and the
 * detached signature downstream mean anything at all.
 *
 * The claim sentences are the load-bearing part. When the generator emits an
 * edge, it renders that edge's relation into the evidence passage's text, so
 * the quote a citation shows genuinely contains the assertion the edge makes.
 * =============================================================================
 */

import type { BoundaryKind, PassageResolution, RelationFamily } from '@/engine/types';

/** A seeded stream in [0,1). The implementation lives in `world.ts`. */
export type Rng = () => number;

/* =============================================================================
 * 1. SMALL DETERMINISTIC PRIMITIVES
 * ========================================================================== */

export function pick<T>(rng: Rng, xs: readonly T[]): T {
  return xs[Math.min(xs.length - 1, Math.floor(rng() * xs.length))];
}

/** Inclusive integer in [lo, hi]. */
export function pickInt(rng: Rng, lo: number, hi: number): number {
  return lo + Math.min(hi - lo, Math.floor(rng() * (hi - lo + 1)));
}

/** Inclusive integer in [lo, hi], skewed towards `lo`. Long tails, small mode. */
export function skewInt(rng: Rng, lo: number, hi: number): number {
  const r = rng();
  return lo + Math.min(hi - lo, Math.floor(r * r * (hi - lo + 1)));
}

/** Fisher-Yates, non-mutating, fed only by the seeded stream. */
export function shuffled<T>(rng: Rng, xs: readonly T[]): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
}

/** Lowercase, hyphenated, ASCII-folded. Used for ids and document codes. */
export function slug(input: string): string {
  const folded = input
    .replace(/[åäàáâã]/g, 'a')
    .replace(/[öøòóôõ]/g, 'o')
    .replace(/[éèêë]/g, 'e')
    .replace(/[üùúû]/g, 'u')
    .replace(/[ÅÄÀÁÂÃ]/g, 'A')
    .replace(/[ÖØÒÓÔÕ]/g, 'O')
    .replace(/[ÉÈÊË]/g, 'E')
    .replace(/[ÜÙÚÛ]/g, 'U')
    .replace(/[æÆ]/g, 'ae');
  return folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Token estimate. Four characters per token is the standard back-of-envelope
 * for English prose, and it is stated as an estimate everywhere it surfaces —
 * the render budget readout is honest about its own denominator or it is just
 * another number that looks precise.
 */
export function tokenCount(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

/* =============================================================================
 * 2. THE NAME POOLS
 * ========================================================================== */

/** Plausible Nordic place elements. Invented where a real site would mislead. */
export const PLACES: readonly string[] = Object.freeze([
  'Tollstrand', 'Bruntorp', 'Rödvik', 'Storsjö', 'Bårsele', 'Härnvik', 'Lysnäs',
  'Vindeln', 'Malungsfors', 'Åseletorp', 'Nykvarn', 'Skogsnäs', 'Öregrund',
  'Grönskär', 'Hallsberg', 'Trollhamn', 'Sandnesfjord', 'Årdalen', 'Kvinnherad',
  'Vaasanpää', 'Porikoski', 'Esbjerghavn', 'Thyborøn', 'Selfossvik', 'Hvidesand',
  'Ludvikaberg', 'Norrfjärd', 'Svartvik', 'Ekenäs', 'Halmvik', 'Tjörnholm',
  'Bodviken', 'Kalixfors', 'Piteälven', 'Storfors', 'Vallby', 'Ödsmål',
  'Fagerhult', 'Ånge', 'Krokom', 'Strömnäs', 'Björkfors', 'Långsele',
  'Njurundabom', 'Hamnskär', 'Ryssvik', 'Ulvön', 'Grimstorp',
]);

const ORG_ROOTS: readonly string[] = Object.freeze([
  'Nord', 'Väst', 'Syd', 'Öst', 'Stor', 'Ny', 'Fjäll', 'Havs', 'Berg', 'Vind',
  'Vatten', 'Sjö', 'Skog', 'Malm', 'Is',
]);

const ORG_TAILS: readonly string[] = Object.freeze([
  'bridge', 'kraft', 'vind', 'ström', 'link', 'grid', 'fors', 'holm', 'viken',
  'stad', 'lund', 'berga', 'näs',
]);

const ORG_SUFFIXES: readonly string[] = Object.freeze([
  'Kraft AB', 'Energi AB', 'Elnät AB', 'Nät AB', 'Power AB', 'Group',
  'Holding AS', 'Infrastruktur AB', 'Systems AB', 'Partners', 'Renewables AS',
  'Energia Oy', 'Energi A/S', 'Utveckling AB', 'Drift AB', 'Teknik AB',
]);

const FACILITY_TYPES: readonly string[] = Object.freeze([
  'Facility', 'Substation', 'Converter Station', 'Storage Site', 'Terminal',
  'Interconnector', 'Wind Farm', 'Hydro Station', 'Depot', 'Grid Node',
  'Switchyard', 'Compressor Hall', 'Battery Park',
]);

const SITE_TYPES: readonly string[] = Object.freeze([
  'Reservoir', 'Quay', 'Yard', 'Corridor', 'Landfall', 'Cable Route',
  'Access Road', 'Cavern', 'Easement', 'Laydown Area',
]);

const GIVEN_NAMES: readonly string[] = Object.freeze([
  'Anders', 'Karin', 'Lars', 'Ingrid', 'Mikael', 'Elin', 'Johan', 'Sofia',
  'Petter', 'Maja', 'Björn', 'Annika', 'Henrik', 'Linnea', 'Gustav', 'Tove',
  'Emil', 'Sanna', 'Rikard', 'Hanna', 'Oskar', 'Klara', 'Nils', 'Astrid',
  'Jonas', 'Ylva', 'Mattias', 'Siri', 'Per', 'Malin', 'Erik', 'Lena',
  'Fredrik', 'Kajsa', 'Olav', 'Ragnhild', 'Mika', 'Aino', 'Teemu', 'Sanni',
  'Søren', 'Mette', 'Jesper', 'Freja',
]);

const SURNAMES: readonly string[] = Object.freeze([
  'Lindqvist', 'Bergström', 'Håkansson', 'Norrback', 'Sjölund', 'Ekvall',
  'Rydell', 'Öberg', 'Vikander', 'Almgren', 'Sandvik', 'Hedlund', 'Nyström',
  'Falkenberg', 'Grönvall', 'Isaksson', 'Lundgren', 'Wikström', 'Åkerlund',
  'Brandt', 'Kallio', 'Virtanen', 'Nieminen', 'Rantala', 'Dahl', 'Solberg',
  'Bjørnstad', 'Kristensen', 'Mikkelsen', 'Thorsen', 'Engström', 'Palmgren',
  'Sundström', 'Wallin', 'Ohlsson', 'Kvist',
]);

const MATERIALS: readonly string[] = Object.freeze([
  'LFP cathode powder', 'NMC-622 cell stock', 'lithium hexafluorophosphate electrolyte',
  'copper busbar stock', 'grain-oriented electrical steel', 'aluminium conductor cable',
  'XLPE insulation compound', 'neodymium-iron-boron magnet stock',
  'silicon carbide power modules', 'graphite anode feed', 'transformer mineral oil',
  'black mass concentrate', 'galvanised lattice steel', 'sulphur hexafluoride replacement gas',
]);

const MATERIAL_LOTS: readonly string[] = Object.freeze([
  'lot A1', 'lot B2', 'lot C4', 'lot D7', 'lot E3', 'lot F9', 'lot G5', 'lot H8',
  'grade K2', 'grade M6', 'grade R1', 'grade T3',
]);

const TECHNOLOGIES: readonly string[] = Object.freeze([
  'liquid-cooled rack architecture', 'grid-forming inverter control',
  'dry-type transformer design', 'STATCOM voltage support',
  'voltage-source converter topology', 'droop-controlled frequency response',
  'second-life module reconditioning', 'immersion fire suppression',
  'synthetic inertia control', 'dynamic line rating', 'phase-shifting transformer control',
  'islanded black-start capability', 'state-of-charge arbitration logic',
]);

const REGULATIONS: readonly string[] = Object.freeze([
  'Elberedskapsförordning 2024:118', 'Nätkoncessionsföreskrift NFS 2023:4',
  'Systemdriftföreskrift SvK 2025-02', 'Miljöprövningsförordning 2023:41',
  'Anslutningsvillkor AV-2024:9', 'Dammsäkerhetsföreskrift DS 2022:6',
  'Balansansvarsavtal BA-2025', 'Kapacitetstilldelningsregel KT-2024:3',
  'Elsäkerhetsföreskrift ELS 2023:12', 'Beredskapsplanförordning 2025:77',
]);

const MARKET_INSTRUMENTS: readonly string[] = Object.freeze([
  'FCR-D upward capacity', 'FCR-N symmetric capacity', 'mFRR energy activation',
  'aFRR capacity band', 'day-ahead baseload block', 'intraday quarter-hour product',
  'PPA tranche B', 'green certificate lot', 'guarantee-of-origin batch',
  'capacity reserve option', 'imbalance settlement position', 'congestion income share',
]);

const PERIOD_SHAPES: readonly string[] = Object.freeze([
  'balancing window', 'outage season', 'hydrological year', 'reporting quarter',
  'delivery period', 'maintenance window', 'settlement month', 'consultation window',
]);

/* =============================================================================
 * 3. ENTITY TYPES
 * ========================================================================== */

export const ENTITY_TYPES = Object.freeze([
  'organization',
  'facility',
  'person',
  'site',
  'material',
  'technology',
  'regulation',
  'market_instrument',
  'period',
] as const);

export type EntityType = (typeof ENTITY_TYPES)[number];

/** Type mix inside one island's cast. Sums to 1; drawn once per entity. */
export const ENTITY_TYPE_WEIGHTS: Readonly<Record<EntityType, number>> = Object.freeze({
  organization: 0.21,
  facility: 0.21,
  person: 0.15,
  site: 0.09,
  material: 0.08,
  technology: 0.08,
  regulation: 0.06,
  market_instrument: 0.06,
  period: 0.06,
});

export interface EntitySpec {
  label: string;
  entity_type: EntityType;
  aliases: string[];
  summary: string;
}

const ENTITY_SUMMARIES: Readonly<Record<EntityType, readonly string[]>> = Object.freeze({
  organization: Object.freeze([
    'Counterparty of record in the corporate index; holds licences in more than one bidding zone.',
    'Registered operator and balance responsible party; files quarterly compliance returns.',
    'Holding company; appears in the register through its operating subsidiaries.',
  ]),
  facility: Object.freeze([
    'Connected installation with a metered point of connection and a declared availability profile.',
    'Physical plant on the register; subject to the connection conditions of its host network.',
    'Operational site carrying its own outage plan and protection settings.',
  ]),
  person: Object.freeze([
    'Named signatory or author appearing across filings, minutes and technical notes.',
    'Individual of record; attributed as author, attendee or responsible engineer.',
    'Recurring participant in the governance and consultation record.',
  ]),
  site: Object.freeze([
    'Land or corridor feature referenced in access, easement and routing documents.',
    'Geographic feature carrying its own consent conditions and access restrictions.',
    'Physical corridor or landholding named in the permitting record.',
  ]),
  material: Object.freeze([
    'Supplied commodity tracked by lot, with lead time and qualification status.',
    'Input material subject to supplier qualification and incoming inspection.',
    'Bulk or component stock referenced in supply agreements and delay notices.',
  ]),
  technology: Object.freeze([
    'Design or control approach cited in technical assessment and acceptance testing.',
    'Engineering method named in specifications and in the commissioning record.',
    'Control or construction technique referenced across several installations.',
  ]),
  regulation: Object.freeze([
    'Instrument of regulation; conditions from it are applied directly to licence holders.',
    'Statutory or code provision governing connection, safety or market conduct.',
    'Regulatory reference invoked in filings, appeals and compliance returns.',
  ]),
  market_instrument: Object.freeze([
    'Traded or contracted product settled against a published reference position.',
    'Market product carrying its own availability, activation and settlement rules.',
    'Contractual product referenced in offtake, reserve and settlement records.',
  ]),
  period: Object.freeze([
    'Bounded window used to anchor temporal claims across the record.',
    'Named interval that filings, outages and settlements are attributed to.',
    'Declared period against which availability and delivery are measured.',
  ]),
});

/**
 * Mint one entity. `taken` guarantees global label uniqueness — a duplicate
 * label would silently merge two atoms, which is the single worst thing that
 * can happen to an entity layer.
 */
export function makeEntitySpec(rng: Rng, type: EntityType, taken: Set<string>): EntitySpec {
  let label: string;
  let aliases: string[] = [];

  switch (type) {
    case 'organization': {
      if (rng() < 0.45) {
        const root = pick(rng, ORG_ROOTS);
        const tail = pick(rng, ORG_TAILS);
        /* `Fjall` + `link` must not become `Fjalllink`. */
        const stem = root + (root.slice(-1) === tail.charAt(0) ? tail.slice(1) : tail);
        label = `${stem} ${pick(rng, ORG_SUFFIXES)}`;
        aliases = [stem];
      } else {
        const place = pick(rng, PLACES);
        label = `${place} ${pick(rng, ORG_SUFFIXES)}`;
        aliases = [place];
      }
      break;
    }
    case 'facility': {
      const place = pick(rng, PLACES);
      label = `${place} ${pick(rng, FACILITY_TYPES)}`;
      aliases = [place];
      break;
    }
    case 'person': {
      const given = pick(rng, GIVEN_NAMES);
      const family = pick(rng, SURNAMES);
      label = `${given} ${family}`;
      aliases = [`${given.charAt(0)}. ${family}`];
      break;
    }
    case 'site': {
      const place = pick(rng, PLACES);
      label = `${place} ${pick(rng, SITE_TYPES)}`;
      aliases = [place];
      break;
    }
    case 'material': {
      label = `${pick(rng, MATERIALS)}, ${pick(rng, MATERIAL_LOTS)}`;
      aliases = [label.split(',')[0]];
      break;
    }
    case 'technology': {
      label = pick(rng, TECHNOLOGIES);
      aliases = [];
      break;
    }
    case 'regulation': {
      label = pick(rng, REGULATIONS);
      aliases = [label.split(' ')[0]];
      break;
    }
    case 'market_instrument': {
      label = pick(rng, MARKET_INSTRUMENTS);
      aliases = [label.split(' ')[0]];
      break;
    }
    case 'period': {
      const q = pickInt(rng, 1, 4);
      const y = pickInt(rng, 2023, 2026);
      label = `Q${q} ${y} ${pick(rng, PERIOD_SHAPES)}`;
      aliases = [`Q${q} ${y}`];
      break;
    }
    default: {
      label = pick(rng, PLACES);
      break;
    }
  }

  label = disambiguate(label, taken, type);
  taken.add(label);

  return {
    label,
    entity_type: type,
    aliases: aliases.filter((a) => a.length > 1 && a !== label),
    summary: pick(rng, ENTITY_SUMMARIES[type]),
  };
}

/**
 * Collision suffixes, chosen per type. A second substation really is called
 * "Rödvik Substation II"; a second control method is not called "dynamic line
 * rating III". Getting this wrong is a small thing that makes the whole corpus
 * read as generated.
 */
const DISAMBIGUATORS: Readonly<Record<EntityType, readonly string[]>> = Object.freeze({
  organization: Object.freeze(['II', 'III', 'IV', 'V', 'VI']),
  facility: Object.freeze(['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII']),
  person: Object.freeze(['(the elder)', '(the younger)']),
  site: Object.freeze(['II', 'III', 'IV', 'V']),
  material: Object.freeze(['(second consignment)', '(third consignment)', '(re-qualified)']),
  technology: Object.freeze(['(rev B)', '(rev C)', '(rev D)', '(2024 revision)', '(2025 revision)']),
  regulation: Object.freeze(['(as amended)', '(consolidated text)', '(2025 amendment)']),
  market_instrument: Object.freeze(['(tranche II)', '(tranche III)', '(revised definition)']),
  period: Object.freeze(['(restated)', '(as reported)']),
});

function disambiguate(base: string, taken: Set<string>, type: EntityType): string {
  if (!taken.has(base)) return base;
  for (const suffix of DISAMBIGUATORS[type]) {
    const candidate = `${base} ${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  for (let k = 2; k < 5000; k++) {
    const candidate = `${base} (record ${k})`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`[corpus/text] exhausted disambiguation space for "${base}"`);
}

/* =============================================================================
 * 4. THE WORLD'S SHAPE — continents and their islands
 * ========================================================================== */

export const DOMAINS = Object.freeze([
  'transmission',
  'storage',
  'permitting',
  'capital',
  'materials',
  'generation',
  'markets',
  'incident',
  'research',
] as const);

export type Domain = (typeof DOMAINS)[number];

export interface IslandProfile {
  readonly key: string;
  readonly name: string;
  readonly domain: Domain;
  readonly summary: string;
}

export interface ContinentProfile {
  readonly key: string;
  readonly name: string;
  readonly summary: string;
  /** Seven candidates; the generator takes the first 5 to 7 of them. */
  readonly islands: readonly IslandProfile[];
}

/**
 * Six continents. Island index 0 of `storage` and of `capital` are load-bearing
 * for the staged bridge query and are therefore always generated: the gold
 * chain crosses the strait between them.
 */
export const CONTINENT_PROFILES: readonly ContinentProfile[] = Object.freeze([
  Object.freeze({
    key: 'transmission',
    name: 'Transmission and System Operation',
    summary:
      'The backbone: bidding-zone congestion, reserve procurement, interconnectors and the outage calendar that keeps them apart.',
    islands: Object.freeze([
      Object.freeze({ key: 'se3-congestion', name: 'Bidding Zone SE3 Congestion', domain: 'transmission' as Domain, summary: 'Structural congestion on the north-south corridor and the counter-trading it forces.' }),
      Object.freeze({ key: 'balancing-model', name: 'Nordic Balancing Model', domain: 'markets' as Domain, summary: 'Reserve products, activation order and the settlement rules that follow from them.' }),
      Object.freeze({ key: 'hvdc-links', name: 'HVDC Interconnectors', domain: 'transmission' as Domain, summary: 'Converter stations, cable ratings and the availability record of the cross-border links.' }),
      Object.freeze({ key: 'substation-fleet', name: 'Substation Fleet', domain: 'transmission' as Domain, summary: 'Primary plant condition, protection settings and the replacement programme.' }),
      Object.freeze({ key: 'reserve-procurement', name: 'Reserve Procurement', domain: 'markets' as Domain, summary: 'Capacity auctions, prequalification and who actually delivered when called.' }),
      Object.freeze({ key: 'outage-coordination', name: 'Outage Coordination', domain: 'incident' as Domain, summary: 'Planned and forced outages, and the disputes about who moved first.' }),
      Object.freeze({ key: 'grid-codes', name: 'Grid Codes and Compliance', domain: 'permitting' as Domain, summary: 'Connection conditions, compliance testing and the derogations granted against them.' }),
    ]),
  }),
  Object.freeze({
    key: 'storage',
    name: 'Storage and Flexibility',
    summary:
      'Battery parks, reserve duty and degradation: the fastest-moving part of the corpus and the one with the least settled vocabulary.',
    islands: Object.freeze([
      Object.freeze({ key: 'tollstrand-cluster', name: 'Tollstrand Cluster', domain: 'storage' as Domain, summary: 'The Tollstrand storage sites, their operators and the facilities they hold mandates over.' }),
      Object.freeze({ key: 'reserve-duty', name: 'Frequency Reserve Duty', domain: 'storage' as Domain, summary: 'How storage assets are actually cycled once they carry a reserve obligation.' }),
      Object.freeze({ key: 'cell-degradation', name: 'Cell Degradation Studies', domain: 'research' as Domain, summary: 'Capacity fade under fast-cycling duty, measured rather than warranted.' }),
      Object.freeze({ key: 'storage-interconnection', name: 'Storage Interconnection', domain: 'transmission' as Domain, summary: 'Connection queues, shared-use agreements and the export limits imposed on them.' }),
      Object.freeze({ key: 'second-life', name: 'Second-Life Cells', domain: 'materials' as Domain, summary: 'Reconditioned modules, their provenance and what the warranty stops covering.' }),
      Object.freeze({ key: 'thermal-hydrogen', name: 'Thermal and Hydrogen Storage', domain: 'research' as Domain, summary: 'Non-electrochemical storage pilots and their round-trip arithmetic.' }),
      Object.freeze({ key: 'aggregator-portfolios', name: 'Aggregator Portfolios', domain: 'markets' as Domain, summary: 'Pooled assets bid as one unit, and the metering that has to hold it together.' }),
    ]),
  }),
  Object.freeze({
    key: 'permitting',
    name: 'Permitting, Environment and Land',
    summary:
      'Concessions, impact assessments, land access and appeals — the slowest terrain in the corpus and the one that decides the others.',
    islands: Object.freeze([
      Object.freeze({ key: 'concession-filings', name: 'Concession Filings', domain: 'permitting' as Domain, summary: 'Network concession applications and the conditions attached on grant.' }),
      Object.freeze({ key: 'impact-reviews', name: 'Environmental Impact Reviews', domain: 'permitting' as Domain, summary: 'Assessment scope, consultation responses and the mitigations actually imposed.' }),
      Object.freeze({ key: 'land-access', name: 'Land Access and Easements', domain: 'permitting' as Domain, summary: 'Corridors, easements and the compensation record behind them.' }),
      Object.freeze({ key: 'husbandry-consultations', name: 'Reindeer Husbandry Consultations', domain: 'permitting' as Domain, summary: 'Consultation obligations over grazing land and migration routes.' }),
      Object.freeze({ key: 'dam-safety', name: 'Water Rights and Dam Safety', domain: 'generation' as Domain, summary: 'Water judgements, spillway capacity and the dam safety classification record.' }),
      Object.freeze({ key: 'municipal-planning', name: 'Municipal Planning', domain: 'permitting' as Domain, summary: 'Detailed plans, building permits and the municipal veto in practice.' }),
      Object.freeze({ key: 'appeals', name: 'Appeals and Litigation', domain: 'permitting' as Domain, summary: 'Challenges to granted permits and what survived them.' }),
    ]),
  }),
  Object.freeze({
    key: 'capital',
    name: 'Corporate Holdings and Capital',
    summary:
      'Who owns what, financed how: holdings, funds, bond covenants, acquisitions and the board records that authorise them.',
    islands: Object.freeze([
      Object.freeze({ key: 'rimsdal-holdings', name: 'Rimsdal Holdings', domain: 'capital' as Domain, summary: 'The Rimsdal group structure, its acquisitions and the board record behind them.' }),
      Object.freeze({ key: 'infrastructure-funds', name: 'Infrastructure Funds', domain: 'capital' as Domain, summary: 'Fund vehicles, their holding periods and the assets moved between them.' }),
      Object.freeze({ key: 'green-bonds', name: 'Debt and Green Bonds', domain: 'capital' as Domain, summary: 'Issuance, covenants and the use-of-proceeds reporting that follows.' }),
      Object.freeze({ key: 'mergers-divestments', name: 'Mergers and Divestments', domain: 'capital' as Domain, summary: 'Transactions in and out of the portfolio, with their conditions precedent.' }),
      Object.freeze({ key: 'board-governance', name: 'Board Governance', domain: 'capital' as Domain, summary: 'Minutes, delegations and the authorisations that transactions rest on.' }),
      Object.freeze({ key: 'offtake-desk', name: 'Offtake and PPA Desk', domain: 'markets' as Domain, summary: 'Long-term offtake, tranching and the credit support behind each contract.' }),
      Object.freeze({ key: 'risk-transfer', name: 'Insurance and Risk Transfer', domain: 'capital' as Domain, summary: 'Cover, deductibles and the claims record against physical assets.' }),
    ]),
  }),
  Object.freeze({
    key: 'materials',
    name: 'Materials and Supply Chain',
    summary:
      'Cells, transformers, cable and magnets: lead times, qualification and the delay notices that reshape every other continent.',
    islands: Object.freeze([
      Object.freeze({ key: 'cathode-supply', name: 'Cathode and Anode Supply', domain: 'materials' as Domain, summary: 'Active material contracts, lot traceability and qualification status.' }),
      Object.freeze({ key: 'transformer-leadtimes', name: 'Transformer and Cable Lead Times', domain: 'materials' as Domain, summary: 'Primary plant lead times and the slot bookings that protect them.' }),
      Object.freeze({ key: 'magnet-sourcing', name: 'Magnet and Rare Earth Sourcing', domain: 'materials' as Domain, summary: 'Magnet supply concentration and the qualification of alternates.' }),
      Object.freeze({ key: 'heavy-haul', name: 'Logistics and Heavy Haul', domain: 'materials' as Domain, summary: 'Route surveys, quay capacity and the escorts that abnormal loads require.' }),
      Object.freeze({ key: 'yard-capacity', name: 'Fabrication and Yard Capacity', domain: 'materials' as Domain, summary: 'Fabrication slots, weld capacity and the queue behind them.' }),
      Object.freeze({ key: 'black-mass', name: 'Recycling and Black Mass', domain: 'materials' as Domain, summary: 'End-of-life routing, black mass assay and the recovered-content claims.' }),
      Object.freeze({ key: 'supplier-qualification', name: 'Supplier Qualification', domain: 'materials' as Domain, summary: 'Audits, first-article inspection and the conditions on approved status.' }),
    ]),
  }),
  Object.freeze({
    key: 'generation',
    name: 'Generation Assets',
    summary:
      'Hydro, wind, nuclear and heat: the producing fleet, its output record and the curtailment it absorbs.',
    islands: Object.freeze([
      Object.freeze({ key: 'hydro-fleet', name: 'Hydro Fleet and Reservoirs', domain: 'generation' as Domain, summary: 'Reservoir levels, water judgements and the refurbishment programme.' }),
      Object.freeze({ key: 'offshore-wind', name: 'Offshore Wind Development', domain: 'generation' as Domain, summary: 'Seabed leases, landfall routing and the phased build record.' }),
      Object.freeze({ key: 'onshore-wind', name: 'Onshore Wind Portfolios', domain: 'generation' as Domain, summary: 'Turbine fleets, availability warranties and the noise conditions imposed.' }),
      Object.freeze({ key: 'nuclear-lto', name: 'Nuclear Long-Term Operation', domain: 'generation' as Domain, summary: 'Life extension cases, component ageing and the regulator correspondence.' }),
      Object.freeze({ key: 'chp-plants', name: 'Combined Heat and Power', domain: 'generation' as Domain, summary: 'Heat obligations, fuel switching and the district network behind them.' }),
      Object.freeze({ key: 'solar-hybrid', name: 'Solar and Hybrid Sites', domain: 'generation' as Domain, summary: 'Co-located generation and storage sharing one connection point.' }),
      Object.freeze({ key: 'curtailment-records', name: 'Curtailment and Output Records', domain: 'incident' as Domain, summary: 'Instructed and economic curtailment, and who was compensated for it.' }),
    ]),
  }),
]);

/** Island index 0 of continent 1 — the storage side of the staged strait. */
export const GOLD_ISLAND_A = Object.freeze({ continent: 'storage', island: 'tollstrand-cluster' });
/** Island index 0 of continent 3 — the capital side of the staged strait. */
export const GOLD_ISLAND_B = Object.freeze({ continent: 'capital', island: 'rimsdal-holdings' });

/** What kinds of declared boundary each domain actually produces. */
export const BOUNDARY_KINDS_BY_DOMAIN: Readonly<Record<Domain, readonly BoundaryKind[]>> =
  Object.freeze({
    transmission: Object.freeze<BoundaryKind[]>(['paper', 'thread', 'session', 'chapter', 'pr']),
    storage: Object.freeze<BoundaryKind[]>(['paper', 'thread', 'contract', 'session']),
    permitting: Object.freeze<BoundaryKind[]>(['contract', 'session', 'chapter', 'thread']),
    capital: Object.freeze<BoundaryKind[]>(['contract', 'session', 'thread', 'chapter']),
    materials: Object.freeze<BoundaryKind[]>(['contract', 'thread', 'session', 'pr']),
    generation: Object.freeze<BoundaryKind[]>(['chapter', 'paper', 'session', 'contract']),
    markets: Object.freeze<BoundaryKind[]>(['contract', 'thread', 'session', 'paper']),
    incident: Object.freeze<BoundaryKind[]>(['thread', 'session', 'chapter']),
    research: Object.freeze<BoundaryKind[]>(['paper', 'chapter', 'thread']),
  });

/* =============================================================================
 * 5. THE CLAIM SENTENCES
 * -----------------------------------------------------------------------------
 * One template per semantic relation family. When the generator emits an edge,
 * it renders the edge's family here and drops the sentence into the passage the
 * edge cites. That is why a citation in this build can be checked: the quote
 * contains the assertion, not a paraphrase of it.
 * ========================================================================== */

const FAMILY_TEMPLATES: Partial<Record<RelationFamily, readonly string[]>> = {
  /* --- factual ---------------------------------------------------------- */
  part_of: ['{s} is recorded as part of {o} in the consolidated asset register.'],
  has_part: ['{s} has {o} as a delivered subsystem within the same installation.'],
  contains: ['{s} contains {o} inside its declared boundary and meters it collectively.'],
  contained_in: ['{s} sits inside {o} and is not metered separately.'],
  is_a: ['{s} is classified as a {o} for the purposes of this schedule.'],
  has_subtype: ['{s} covers a subtype, {o}, which the annex treats separately.'],
  instance_of: ['{s} is an instance of {o} as defined in the reference architecture.'],
  has_instance: ['{s} is realised in practice by {o} at the connection point.'],
  made_of: ['{s} is made of {o} in the delivered configuration.'],
  material_in: ['{s} is the material specified in {o}.'],
  has_attribute: ['{s} is recorded with {o} in the technical dossier.'],
  attribute_of: ['{s} is an attribute of {o} captured during commissioning.'],
  owns: ['{s} owns {o} outright following completion of the transfer.'],
  owned_by: ['{s} is owned by {o} through an intermediate holding company.'],
  operates: [
    '{s} operates {o} under a fifteen-year operations and maintenance mandate.',
    '{s} operates {o} on behalf of the owner and is the registered point of contact.',
  ],
  operated_by: ['{s} is operated by {o} under a service agreement running to the end of the decade.'],
  located_in: ['{s} is located in {o}, some nine kilometres from the nearest connection point.'],
  location_of: ['{s} is the location of {o} and of the associated switchgear.'],
  member_of: ['{s} is a member of {o} and votes in its technical committee.'],
  has_member: ['{s} counts {o} among its members.'],
  subsidiary_of: ['{s} is a wholly owned subsidiary of {o}.'],
  has_subsidiary: ['{s} holds {o} as a subsidiary.'],
  supplies: ['{s} supplies {o} under a framework agreement renewed each January.'],
  supplied_by: ['{s} is supplied by {o} on a twelve-week lead time.'],
  regulates: ['{s} regulates {o} and may impose conditions on its operation.'],
  regulated_by: ['{s} is regulated by {o} and files quarterly compliance returns.'],
  identifies: ['{s} identifies {o} in the register of connection points.'],
  identified_by: ['{s} is identified by {o} in every settlement message.'],
  has_role: ['{s} has the role {o} under the balancing arrangement.'],
  role_of: ['{s} is the role held by {o} under the balancing arrangement.'],
  same_as: ['{s} and {o} are the same legal entity following the renaming.'],
  differs_from: ['{s} differs from {o} despite the similar naming in earlier filings.'],
  adjacent_to: ['{s} is adjacent to {o} and shares its access road.'],
  denominated_in: ['{s} is denominated in {o} for settlement purposes.'],

  /* --- temporal --------------------------------------------------------- */
  occurred_at: ['{s} occurred during {o} and was logged the same day.'],
  started_at: ['{s} started at the opening of {o}.'],
  ended_at: ['{s} ended before {o} closed.'],
  valid_from: ['{s} is valid from the first day of {o}.'],
  valid_until: ['{s} remains valid until the end of {o}.'],
  scheduled_for: ['{s} is scheduled for {o}, subject to outage approval.'],
  before: ['{s} takes place before {o}.'],
  after: ['{s} takes place after {o} and depends on its completion.'],
  during: ['{s} runs during {o} without interruption.'],
  spans: ['{s} spans {o} in full.'],
  supersedes: ['{s} supersedes {o} with effect from the date of signature.'],
  superseded_by: ['{s} is superseded by {o} and is retained for reference only.'],
  overlaps: ['{s} overlaps {o} by roughly three weeks.'],
  concurrent_with: ['{s} is concurrent with {o} and was scheduled against it deliberately.'],

  /* --- causal ----------------------------------------------------------- */
  causes: ['{s} causes {o} whenever the reserve is fully activated.'],
  caused_by: ['{s} is caused by {o} under sustained low-flow conditions.'],
  enables: ['{s} enables {o} without further grid reinforcement.'],
  enabled_by: ['{s} is enabled by {o} and by nothing else in the current scheme.'],
  prevents: ['{s} prevents {o} from propagating past the busbar.'],
  prevented_by: ['{s} is prevented by {o} in the protection scheme as set.'],
  triggers: ['{s} triggers {o} within two hundred milliseconds.'],
  triggered_by: ['{s} is triggered by {o} at the configured threshold.'],
  contributes_to: ['{s} contributes to {o} but is not the dominant term.'],
  has_contributor: ['{s} has {o} as a contributing factor in the incident analysis.'],
  depends_on: ['{s} depends on {o} for its firm capacity.'],
  required_by: ['{s} is required by {o} before energisation.'],

  /* --- episodic --------------------------------------------------------- */
  acquired: [
    '{s} acquired {o} in a cash-and-shares transaction that closed in the same quarter.',
    '{s} acquired {o} together with the associated grid connection rights.',
  ],
  acquired_by: ['{s} was acquired by {o} after a competitive process.'],
  divested: ['{s} divested {o} to a regional buyer at book value.'],
  divested_by: ['{s} was divested by {o} as a condition of the refinancing.'],
  participated_in: ['{s} participated in {o} and submitted a bid in the first round.'],
  had_participant: ['{s} had {o} as a participant of record.'],
  attended: ['{s} attended {o} and recorded a dissent.'],
  filed: ['{s} filed {o} with the supervisory authority inside the statutory window.'],
  announced: ['{s} announced {o} in a market notice the same morning.'],
  commissioned: ['{s} commissioned {o} and accepted handover without reservation.'],
  decommissioned: ['{s} decommissioned {o} and returned the site to the landowner.'],

  /* --- authorial -------------------------------------------------------- */
  authored: ['{s} authored {o}.'],
  authored_by: ['{s} was authored by {o} and circulated unchanged.'],
  derived_from: ['{s} is derived from {o} with editorial changes only.'],
  has_derivative: ['{s} has {o} as a derivative work.'],
  cites: ['{s} cites {o} in support of the load assumption.'],
  cited_by: ['{s} is cited by {o} on the same point.'],
  quotes: ['{s} quotes {o} at length and without alteration.'],
  quoted_by: ['{s} is quoted by {o} in the covering note.'],
  edited: ['{s} edited {o} before circulation.'],
  edited_by: ['{s} was edited by {o} ahead of the meeting.'],
  summarizes: ['{s} summarizes {o} for the steering group.'],
  summarized_by: ['{s} is summarized by {o} in two paragraphs.'],
  attributed_to: ['{s} is attributed to {o} in the extraction record.'],
};

/** Fallback for any family without a hand-written template. `{f}` is the label. */
const ANNEX_FRAMES: readonly string[] = Object.freeze([
  '{s} is linked to {o} in the extraction annex under the relation {f}.',
  '{s} is recorded against {o} with the relation noted as {f}.',
]);

/**
 * Connectives. Every template begins with `{s}`, so a leading clause composes
 * without breaking capitalisation. Four empty entries keep a good share of
 * sentences plain.
 */
const CONNECTIVES: readonly string[] = Object.freeze([
  '', '', '', '',
  'For the avoidance of doubt, ',
  'The annex confirms that ',
  'On the record as it stands, ',
  'As entered in the register, ',
  'Subject to the caveats above, ',
]);

/**
 * Not every entity label is a proper noun — `mFRR energy activation` and
 * `dynamic line rating` are perfectly good subjects that simply do not start
 * with a capital. Rather than upper-casing them (which would mangle `mFRR`), a
 * sentence that would otherwise open on one is given a lead-in clause.
 */
const LEAD_INS: readonly string[] = Object.freeze([
  'The annex notes that ',
  'In the same record, ',
  'It is recorded that ',
  'On the evidence available, ',
  'As set out above, ',
]);

function opensLowercase(sentence: string): boolean {
  const c = sentence.charAt(0);
  return c !== '' && c === c.toLowerCase() && c !== c.toUpperCase();
}

function ensureSentenceStart(rng: Rng, sentence: string): string {
  return opensLowercase(sentence) ? pick(rng, LEAD_INS) + sentence : sentence;
}

/**
 * Render one relation as a sentence containing both labels verbatim.
 *
 * The substring guarantee is deliberate and is checked by `validateWorld`: a
 * citation for this edge shows a quote that literally states the claim.
 */
export function claimSentence(
  rng: Rng,
  family: RelationFamily,
  subject: string,
  object: string,
  familyLabel: string,
): string {
  const variants = FAMILY_TEMPLATES[family];
  const template =
    variants && variants.length > 0
      ? pick(rng, variants)
      : pick(rng, ANNEX_FRAMES).replace('{f}', familyLabel);
  const body = template.replace('{s}', subject).replace('{o}', object);
  return ensureSentenceStart(rng, pick(rng, CONNECTIVES) + body);
}

/* =============================================================================
 * 6. MEASUREMENTS
 * ========================================================================== */

/** A plausible magnitude for a unit. Deterministic; never rounded for effect. */
export function metric(rng: Rng, unit: string): string {
  switch (unit) {
    case 'MW': return `${pickInt(rng, 12, 480)} MW`;
    case 'MWh': return `${pickInt(rng, 20, 1200)} MWh`;
    case 'GWh': return `${(1.2 + rng() * 46).toFixed(1)} GWh`;
    case 'kV': return `${pick(rng, [24, 52, 72, 130, 145, 220, 300, 400])} kV`;
    case 'MVAr': return `${pickInt(rng, 10, 220)} MVAr`;
    case 'Hz': return `${(49.4 + rng() * 0.9).toFixed(2)} Hz`;
    case 'SEK/MWh': return `${pickInt(rng, 180, 1450)} SEK per MWh`;
    case 'EUR/kW/yr': return `${pickInt(rng, 8, 46)} EUR per kW-year`;
    case 'MSEK': return `${pickInt(rng, 6, 2400)} MSEK`;
    case 'percent': return `${(0.4 + rng() * 14.4).toFixed(1)} percent`;
    case 'basis points': return `${pickInt(rng, 15, 340)} basis points`;
    case 'hours': return `${pickInt(rng, 2, 96)} hours`;
    case 'minutes': return `${pickInt(rng, 3, 210)} minutes`;
    case 'days': return `${pickInt(rng, 3, 240)} days`;
    case 'weeks': return `${pickInt(rng, 4, 64)} weeks`;
    case 'years': return `${pickInt(rng, 2, 30)} years`;
    case 'km': return `${pickInt(rng, 3, 180)} km`;
    case 'metres': return `${pickInt(rng, 8, 260)} metres`;
    case 'hectares': return `${pickInt(rng, 4, 900)} hectares`;
    case 'tonnes': return `${pickInt(rng, 40, 9000)} tonnes`;
    case 'cycles': return `${pickInt(rng, 120, 3400)} full cycles`;
    case 'degC': return `${pickInt(rng, -24, 34)} degrees Celsius`;
    default: return `${pickInt(rng, 2, 99)} ${unit}`;
  }
}

/* =============================================================================
 * 7. PARAGRAPH LEXICON
 * ========================================================================== */

interface DomainLex {
  /** Opens the first span of a document. Consumes {d} and {x}. */
  readonly openers: readonly string[];
  /** Observations about a PLACE - a facility or a site. Consumes {p}. */
  readonly obsPlace: readonly string[];
  /** Observations about an ACTOR - an organization or a person. Consumes {n}. */
  readonly obsActor: readonly string[];
  /** Title vocabulary for this domain. */
  readonly topics: readonly string[];
}

/**
 * The observation pools are SPLIT BY WHAT THE SLOT CAN BE. One shared pool
 * would produce "Two racks at Erik Sjolund were isolated" - a sentence that is
 * grammatical, plausible-looking and wrong, which is the exact failure mode
 * this corpus exists to avoid. A place slot only ever takes a facility or a
 * site; an actor slot only ever takes an organization or a person.
 */
const LEX: Readonly<Record<Domain, DomainLex>> = Object.freeze({
  transmission: {
    openers: [
      'Recorded under the operational log for {d}, with reference to the {x} corridor.',
      'The system operator note of {d} sets out the position on {x}.',
      'This section restates the connection conditions applied to {x}.',
      'Following the coordination call of {d}, the parties agreed the sequence set out below.',
    ],
    obsPlace: [
      'Loading on the {p} section peaked at {u:MW} against a seasonal rating of {u:MW}.',
      'Voltage at the {p} busbar stayed inside the statutory band, with a minimum of {u:kV}.',
      'Transfer capacity through {p} was held back by {u:MW} for the duration of the works.',
    ],
    obsActor: [
      '{n} held balance responsibility for the period and was notified in writing.',
      'Redispatch attributed to {n} came to {u:MW}, of which roughly a third was reversed inside the hour.',
      '{n} was invoiced {u:MSEK} for counter-trading over the same window.',
    ],
    topics: ['corridor loading', 'counter-trading', 'protection coordination', 'reactive support', 'connection conditions', 'transfer capacity', 'busbar reconfiguration', 'redispatch accounting'],
  },
  storage: {
    openers: [
      'Cycle records for {d} were pulled from the site historian and are summarised here.',
      'The duty profile recorded for {x} over the reporting week is set out below.',
      'This entry accompanies the availability declaration filed on {d}.',
      'The commissioning team note of {d} covers the items listed here.',
    ],
    obsPlace: [
      'Available energy at {p} was {u:MWh} after derating for temperature.',
      'Two racks at {p} were isolated pending replacement of a single module.',
      'Round-trip efficiency at {p} measured {u:percent} across {u:cycles}.',
    ],
    obsActor: [
      '{n} recorded a state-of-health of {u:percent} on the oldest string in service.',
      'Throughput for the month reached {u:MWh}, with {n} taking the larger share.',
      '{n} declared availability late on two days and accepted the resulting deduction.',
    ],
    topics: ['cycle duty', 'state of health', 'availability declaration', 'thermal derating', 'rack replacement', 'round-trip efficiency', 'export limitation', 'commissioning acceptance'],
  },
  permitting: {
    openers: [
      'The filing of {d} is reproduced here with the annexes omitted.',
      'Consultation responses concerning {x} are summarised in this section.',
      'The authority requested further information on {d}; the response is recorded below.',
      'This extract covers the conditions attached to the permit held for {x}.',
    ],
    obsPlace: [
      'The corridor across {p} affects {u:hectares} of productive land.',
      'Mitigation conditions were imposed at {p} covering seasonal working restrictions.',
      'Access to {p} is restricted between May and August under the consent.',
    ],
    obsActor: [
      '{n} objected on noise grounds and the objection was upheld in part.',
      '{n} was given {u:days} to respond to the request for further information.',
      '{n} withdrew its representation once the routing was amended.',
    ],
    topics: ['concession application', 'impact assessment', 'consultation response', 'easement negotiation', 'condition compliance', 'appeal grounds', 'route selection', 'compensation settlement'],
  },
  capital: {
    openers: [
      'Minuted at the meeting of {d}, with {x} taken first on the agenda.',
      'The transaction note of {d} records the following in relation to {x}.',
      'This extract is taken from the investment committee paper circulated on {d}.',
      'Conditions precedent to the transfer of {x} are set out below.',
    ],
    obsPlace: [
      'Consideration attributed to {p} was stated as {u:MSEK}, subject to a working capital adjustment.',
      '{p} was excluded from the perimeter and will be transferred under a separate instrument.',
      'The valuation of {p} assumes a holding period of {u:years}.',
    ],
    obsActor: [
      'The board authorised the transaction unanimously, with {n} abstaining on conflict grounds.',
      '{n} was appointed to provide the fairness opinion.',
      'Net debt at {n} after completion stands at {u:MSEK}, against a covenant tested quarterly.',
    ],
    topics: ['board authorisation', 'conditions precedent', 'covenant testing', 'consideration structure', 'holding period', 'fairness opinion', 'group reorganisation', 'use of proceeds'],
  },
  materials: {
    openers: [
      'The supplier report of {d} concerns delivery against the {x} scope.',
      'This note records the qualification status of {x} as at {d}.',
      'Incoming inspection findings for the shipment received on {d} are set out here.',
      'The delay notice issued on {d} is reproduced without amendment.',
    ],
    obsPlace: [
      'The consignment was routed to {p} and required an abnormal load escort.',
      'Incoming inspection at {p} closed with two minor observations.',
      'Laydown at {p} is committed until the end of the delivery window.',
    ],
    obsActor: [
      '{n} holds approved-supplier status subject to annual audit.',
      'Quoted lead time from {n} moved from {u:weeks} to {u:weeks} between the two most recent confirmations.',
      '{n} accepted liquidated damages of {u:MSEK} without contesting the calculation.',
    ],
    topics: ['lead time', 'supplier qualification', 'incoming inspection', 'lot traceability', 'delay notice', 'abnormal load routing', 'alternate qualification', 'recovered content'],
  },
  generation: {
    openers: [
      'Output records for {d} are summarised here for the {x} scope.',
      'This chapter covers the refurbishment case prepared for {x}.',
      'The operating report of {d} records the following.',
      'Inflow and reservoir conditions over the period covered by {x} are set out below.',
    ],
    obsPlace: [
      'Generation at {p} over the period totalled {u:GWh}, against a budget set before the outage.',
      '{p} was curtailed on network grounds for {u:hours} in aggregate.',
      'Reservoir content upstream of {p} stood at {u:percent} of the seasonal median.',
    ],
    obsActor: [
      '{n} reported availability of {u:percent}, with the shortfall attributable to a single forced outage.',
      '{n} carries the heat obligation for the period and has not sought relief from it.',
      '{n} submitted the life-extension case ahead of the statutory deadline.',
    ],
    topics: ['output record', 'availability warranty', 'reservoir management', 'life extension', 'forced outage', 'curtailment compensation', 'heat obligation', 'commissioning acceptance'],
  },
  markets: {
    openers: [
      'Auction results for {d} are recorded here as published.',
      'This note sets out the settlement position for {x} over the delivery period.',
      'The prequalification result issued on {d} is summarised below.',
      'Bid and activation records covering {x} are reproduced here.',
    ],
    obsPlace: [
      'Metered volume at {p} settled at {u:MWh} for the month.',
      'Prequalified capacity at {p} was reduced to {u:MW} after the retest.',
      'Activation at {p} was instructed {u:minutes} into the delivery window.',
    ],
    obsActor: [
      '{n} was activated repeatedly in the period and delivered inside tolerance each time.',
      'Imbalance exposure for {n} settled at {u:MSEK} for the month.',
      '{n} cleared {u:MW} of the procured volume at the marginal price.',
    ],
    topics: ['capacity auction', 'activation record', 'prequalification', 'imbalance settlement', 'bid curve', 'delivery tolerance', 'product definition', 'reference price'],
  },
  incident: {
    openers: [
      'Control-room thread opened at {d} concerning {x}.',
      'This is the consolidated incident record for the event of {d}.',
      'The initial notification of {d} was followed by the detail set out here.',
      'Sequence of events for the disturbance affecting {x} is reproduced below.',
    ],
    obsPlace: [
      'Protection at {p} operated correctly; the backup zone did not pick up.',
      'Load at risk at {p} during the event was {u:MW}, none of which was interrupted.',
      'Restoration at {p} was complete within {u:minutes} of the last isolation.',
    ],
    obsActor: [
      '{n} reported the trip and initiated the switching plan without waiting for instruction.',
      '{n} was notified within {u:minutes} and confirmed receipt.',
      '{n} disputes the sequence recorded below and has asked for the alarm log.',
    ],
    topics: ['sequence of events', 'protection operation', 'restoration plan', 'load at risk', 'root cause', 'switching error', 'alarm flood', 'post-event review'],
  },
  research: {
    openers: [
      'Method and sample description for the study of {x} are given here.',
      'This section reports results for the test campaign completed on {d}.',
      'The measurement protocol applied to {x} is described below.',
      'Findings are stated with their measurement uncertainty rather than as a warranty position.',
    ],
    obsPlace: [
      'The sample drawn at {p} diverged from the population mean by more than the stated tolerance.',
      'Measurements at {p} were repeated after {u:cycles} with the same result.',
      'Conditions at {p} were held inside the stated tolerance throughout.',
    ],
    obsActor: [
      '{n} supplied the test articles and had no role in the analysis.',
      '{n} reproduced the result in a second batch and reported no divergence.',
      '{n} funded the campaign; the funding is disclosed here rather than in a footnote.',
    ],
    topics: ['capacity fade', 'accelerated ageing', 'measurement uncertainty', 'test protocol', 'sample selection', 'model limits', 'reproduction study', 'failure mode analysis'],
  },
});

/**
 * Observations about a THING - a material, a technology, a regulation, a market
 * product or a period. These read the same across domains, so they are shared;
 * the domain flavour arrives through the opener and the units instead.
 */
const OBS_THING: readonly string[] = Object.freeze([
  'The specification names {g} explicitly, and no alternate was qualified.',
  '{g} is carried in the register without qualification and has not been restated.',
  'Reliance on {g} was flagged as a single point of failure.',
  'The assessment treats {g} as fixed for the period.',
  'A deviation against {g} was raised and closed within {u:days}.',
  '{g} appears in the same annex and is reproduced without change.',
  'The parties agreed to review {g} at the next coordination meeting.',
  'No change to {g} was recorded during the window.',
]);

/** Observations about a PERSON. Consumes {n}. Shared across every domain. */
const OBS_PERSON: readonly string[] = Object.freeze([
  '{n} signed the record on behalf of the party named above.',
  '{n} raised the point at the meeting and asked for it to be minuted.',
  '{n} is the responsible engineer for this scope.',
  '{n} attended and did not object.',
  '{n} prepared the underlying calculation and has retained the working.',
  '{n} was copied on the notification but did not respond.',
  '{n} holds the delegation required to approve this item.',
  '{n} confirmed the figures against the source records.',
]);

/**
 * A document opens once; later spans continue it. Reusing the opening sentence
 * on every span was the most obvious generated-text smell in the first pass of
 * this corpus.
 */
const CONTINUATION_OPENERS: readonly string[] = Object.freeze([
  'The section that follows deals with {x}.',
  'Turning to {x}, the record continues.',
  'A further point, recorded here for completeness, concerns {x}.',
  'The next item on the file is {x}.',
  'What follows was appended after the initial circulation.',
  'The detail behind the summary above is set out here.',
  'This part of the record was added at the request of the reviewer.',
  'Continuing the same thread, the following was entered.',
]);

/* =============================================================================
 * 8. RESOLUTION DISCLOSURE — the recoverable transformations
 * -----------------------------------------------------------------------------
 * A resolved passage is NOT what the document says. The engine has to be able
 * to prove that, so a resolved passage keeps its verbatim span offsets and the
 * transformation is a single, targeted, reversible substitution. A system that
 * volunteers "this quote is resolved, not verbatim" is more trustworthy than
 * any badge.
 * ========================================================================== */

/**
 * Anaphora that a coref pass replaces with the referent's canonical label.
 *
 * All seven are written in a corporate voice, so the generator only ever
 * resolves them to an ORGANIZATION. "The operator has since confirmed" reads
 * as English; "The installation has since confirmed" does not, and a resolved
 * quote that reads wrong undermines the disclosure it is supposed to earn.
 */
export const ANAPHORA: readonly string[] = Object.freeze([
  'The operator',
  'The company',
  'The licensee',
  'The applicant',
  'The counterparty',
  'The supplier',
  'The holder',
]);

const ANAPHOR_TAILS: readonly string[] = Object.freeze([
  '{ana} has since confirmed that the figure will be restated in the next revision.',
  '{ana} remains the counterparty of record for this item.',
  '{ana} accepted the finding without reservation.',
  '{ana} asked that the underlying measurement be retained for audit.',
  '{ana} will carry the residual obligation into the following period.',
  '{ana} disputed the allocation and reserved its position in writing.',
]);

export interface Abbreviation {
  readonly short: string;
  readonly long: string;
}

/** Abbreviations a term-resolution pass expands to their canonical form. */
export const ABBREVIATIONS: readonly Abbreviation[] = Object.freeze([
  Object.freeze({ short: 'BRP', long: 'balance responsible party' }),
  Object.freeze({ short: 'FCR-D', long: 'Frequency Containment Reserve for Disturbances' }),
  Object.freeze({ short: 'FCR-N', long: 'Frequency Containment Reserve for Normal operation' }),
  Object.freeze({ short: 'mFRR', long: 'manual Frequency Restoration Reserve' }),
  Object.freeze({ short: 'aFRR', long: 'automatic Frequency Restoration Reserve' }),
  Object.freeze({ short: 'PPA', long: 'power purchase agreement' }),
  Object.freeze({ short: 'BESS', long: 'battery energy storage system' }),
  Object.freeze({ short: 'DSO', long: 'distribution system operator' }),
  Object.freeze({ short: 'TSO', long: 'transmission system operator' }),
  Object.freeze({ short: 'EIA', long: 'environmental impact assessment' }),
  Object.freeze({ short: 'COD', long: 'commercial operation date' }),
  Object.freeze({ short: 'LFP', long: 'lithium iron phosphate' }),
]);

const ABBREV_TAILS: readonly string[] = Object.freeze([
  'Settlement for the period follows the {abbr} rules in force at the time.',
  'The obligation is stated in {abbr} terms and is not netted against other products.',
  'Availability was declared against {abbr} for the whole window.',
  'The finding was reported to the {abbr} contact point the same day.',
]);

const PLAIN_TAILS: readonly string[] = Object.freeze([
  'No further action was recorded against this item.',
  'The entry was reviewed at the following meeting and left unchanged.',
  'A copy was placed on the project record.',
  'The point was noted without discussion.',
]);

/* =============================================================================
 * 9. TITLES
 * ========================================================================== */

/** A document control code, e.g. `KVH-0142`. Keeps every asset title unique. */
export function documentCode(islandKey: string, index: number): string {
  const letters = slug(islandKey)
    .replace(/-/g, '')
    .toUpperCase()
    .slice(0, 3)
    .padEnd(3, 'X');
  return `${letters}-${String(index).padStart(4, '0')}`;
}

/**
 * The asset title. Titles carry their document control code because the
 * corpus cross-references assets by name in the prose, and two identically
 * titled board minutes would make a citation ambiguous.
 */
export function assetTitle(input: {
  rng: Rng;
  kind: BoundaryKind;
  domain: Domain;
  islandName: string;
  code: string;
  dateLabel: string;
  lead: string;
  second: string;
}): string {
  const { rng, kind, domain, code, dateLabel, lead, second } = input;
  const topic = pick(rng, LEX[domain].topics);
  let stem: string;
  switch (kind) {
    case 'contract':
      stem = pick(rng, [
        `Offtake agreement — ${lead} and ${second}, schedule ${pick(rng, ['A', 'B', 'C', 'D'])}`,
        `Framework agreement for ${topic}: ${lead} and ${second}`,
        `Connection agreement, ${lead} at ${second}`,
        `Operations and maintenance agreement — ${lead}`,
      ]);
      break;
    case 'paper':
      stem = pick(rng, [
        `${capitalise(topic)} at ${lead}: measurement and method`,
        `Assessment of ${topic} across the ${input.islandName} portfolio`,
        `${capitalise(topic)} under sustained duty: evidence from ${lead}`,
      ]);
      break;
    case 'thread':
      stem = pick(rng, [
        `Thread: ${topic} at ${lead}, week ${pickInt(rng, 2, 51)}`,
        `Control-room thread — ${topic}, ${dateLabel}`,
        `Thread: ${lead} and ${second}, ${topic}`,
      ]);
      break;
    case 'pr':
      stem = pick(rng, [
        `PR ${pickInt(rng, 108, 1480)}: correct ${topic} in the settlement path`,
        `PR ${pickInt(rng, 108, 1480)} — ${topic} for ${lead}`,
        `PR ${pickInt(rng, 108, 1480)}: register ${lead} against the correct connection point`,
      ]);
      break;
    case 'chapter':
      stem = pick(rng, [
        `Chapter ${pickInt(rng, 1, 14)} — ${capitalise(topic)}`,
        `Chapter ${pickInt(rng, 1, 14)}: ${topic} in the ${input.islandName} record`,
        `Chapter ${pickInt(rng, 1, 14)} — ${lead} and the ${topic} question`,
      ]);
      break;
    case 'session':
    default:
      stem = pick(rng, [
        `Board minutes, ${dateLabel} — ${lead}`,
        `Working session, ${dateLabel}: ${topic}`,
        `Coordination session, ${dateLabel} — ${lead} and ${second}`,
      ]);
      break;
  }
  return `${stem} (${code})`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** One-line engine abstract for the asset. Shown at lod-1. NEVER cited. */
export function assetSummary(input: {
  rng: Rng;
  kind: BoundaryKind;
  domain: Domain;
  lead: string;
  second: string;
  dateLabel: string;
}): string {
  const { rng, kind, domain, lead, second, dateLabel } = input;
  const topic = pick(rng, LEX[domain].topics);
  const frame = pick(rng, [
    `Declared boundary: ${kind}, ${dateLabel}. Establishes the position of ${lead} on ${topic}, with ${second} named throughout.`,
    `A ${kind} of ${dateLabel} covering ${topic}; ${lead} is the principal subject and ${second} the counterparty of record.`,
    `${capitalise(kind)} dated ${dateLabel}. Sets out ${topic} and the obligations it places on ${lead}.`,
  ]);
  return frame;
}

/** MIME-ish type of the ingested artifact, by declared boundary. */
export function mediaTypeFor(kind: BoundaryKind): string {
  switch (kind) {
    case 'contract': return 'application/pdf';
    case 'paper': return 'application/pdf';
    case 'thread': return 'message/rfc822';
    case 'pr': return 'text/x-patch';
    case 'chapter': return 'text/markdown';
    case 'session': default: return 'text/plain';
  }
}

/** The locator as ingested. Shown verbatim in provenance rows. */
export function sourceLocator(input: {
  continentKey: string;
  islandKey: string;
  year: number;
  code: string;
  kind: BoundaryKind;
}): string {
  const ext =
    input.kind === 'thread' ? 'eml'
      : input.kind === 'pr' ? 'patch'
        : input.kind === 'chapter' ? 'md'
          : input.kind === 'session' ? 'txt'
            : 'pdf';
  return `corpus://nordic-energy/${input.continentKey}/${input.islandKey}/${input.year}/${slug(input.code)}.${ext}`;
}

/**
 * The source's front matter. It sits BEFORE the first passage, so passage
 * offsets are never zero and a downstream slice that ignores `char_start`
 * produces visibly wrong text rather than plausibly wrong text.
 */
export function sourceHeader(input: {
  title: string;
  code: string;
  locator: string;
  kind: BoundaryKind;
  dateLabel: string;
}): string {
  return (
    `${input.title}\n` +
    `Document control: ${input.code} · classification: internal · retention: 10 years\n` +
    `Locator: ${input.locator}\n` +
    `Declared boundary: ${input.kind}, ${input.dateLabel}\n\n`
  );
}

/* =============================================================================
 * 10. PARAGRAPHS
 * ========================================================================== */

/** One entity a paragraph is about, with the type that decides how it is used. */
export interface FocusEntity {
  readonly label: string;
  readonly type: EntityType;
}

export interface ParagraphInput {
  rng: Rng;
  domain: Domain;
  /** Reading-order index inside the asset. Span 0 opens the document. */
  seq: number;
  dateLabel: string;
  /** Entity this paragraph is about. Every one of them lands in the bytes. */
  focus: readonly FocusEntity[];
  /** Pre-rendered claim sentences for the edges this passage evidences. */
  claims: readonly string[];
  /** Which disclosure to produce, if any. */
  want: 'none' | 'coref' | 'term';
  /** The label a coref pass resolves the anaphor to. Always an organization. */
  corefTarget: string;
  /** Rotates the continuation openers so two spans never open identically. */
  openerOffset: number;
  /**
   * Templates already spent inside this ASSET. Passed in and mutated so that a
   * document does not repeat the same observation in three consecutive spans,
   * which is the tell that gives generated prose away fastest.
   */
  usedTemplates: Set<string>;
}

export interface ParagraphDraft {
  /** The bytes that land in the source. What a citation is checked against. */
  verbatim: string;
  /** What the passage renders as. Identical to `verbatim` when unresolved. */
  rendered: string;
  resolution: PassageResolution;
}

function isPlace(t: EntityType): boolean {
  return t === 'facility' || t === 'site';
}

export function paragraphFor(input: ParagraphInput): ParagraphDraft {
  const { rng, domain, focus, claims, dateLabel, seq, openerOffset } = input;
  const lex = LEX[domain];
  const anyLabel = focus.length > 0 ? focus[0].label : 'the site';

  const fill = (t: string, subject: string): string =>
    t
      .replace(/\{[png]\}/g, subject)
      .replace(/\{x\}/g, anyLabel)
      .replace(/\{d\}/g, dateLabel)
      /* Every measurement slot names its own unit, so a state-of-health is a
         percentage and a lead time is in weeks. */
      .replace(/\{u:([^}]+)\}/g, (_all, unit: string) => metric(rng, unit));

  const opener =
    seq === 0
      ? pick(rng, lex.openers)
      : CONTINUATION_OPENERS[(openerOffset + seq) % CONTINUATION_OPENERS.length];

  const parts: string[] = [ensureSentenceStart(rng, fill(opener, anyLabel))];
  for (const c of claims) parts.push(c);

  /* One observation per focus entity, drawn from the pool its TYPE allows.
     This is what guarantees both that the prose stays sensible and that every
     entity the generator is about to attach to this passage is really in it. */
  const usedTemplates = input.usedTemplates;
  for (const f of focus) {
    const pool = isPlace(f.type)
      ? lex.obsPlace
      : f.type === 'person'
        ? OBS_PERSON
        : f.type === 'organization'
          ? lex.obsActor
          : OBS_THING;
    const fresh = pool.filter((t) => !usedTemplates.has(t));
    const template = pick(rng, fresh.length > 0 ? fresh : pool);
    usedTemplates.add(template);
    parts.push(ensureSentenceStart(rng, fill(template, f.label)));
  }

  let verbatim = parts.join(' ');

  /* Backstop. An entity listed on a passage that does not name it would be a
     lie the drilldown exposes on the first click, so the guarantee is enforced
     rather than assumed. */
  const missing = focus.filter((f) => !verbatim.includes(f.label)).map((f) => f.label);
  if (missing.length > 0) {
    verbatim += ` Also named in this section: ${missing.join(', ')}.`;
  }

  let rendered = verbatim;
  let resolution: PassageResolution = 'verbatim';

  if (input.want === 'coref') {
    const ana = pick(rng, ANAPHORA);
    const tail = pick(rng, ANAPHOR_TAILS).replace('{ana}', ana);
    verbatim = `${verbatim} ${tail}`;
    rendered = verbatim.replace(ana, input.corefTarget);
    resolution = rendered === verbatim ? 'verbatim' : 'coref_resolved';
  } else if (input.want === 'term') {
    const candidates = ABBREVIATIONS.filter((x) => !verbatim.includes(x.short));
    if (candidates.length > 0) {
      const abbr = pick(rng, candidates);
      const tail = pick(rng, ABBREV_TAILS).replace('{abbr}', abbr.short);
      verbatim = `${verbatim} ${tail}`;
      rendered = verbatim.replace(abbr.short, `${abbr.long} (${abbr.short})`);
      resolution = 'term_resolved';
    } else {
      verbatim = `${verbatim} ${pick(rng, PLAIN_TAILS)}`;
      rendered = verbatim;
    }
  } else if (rng() < 0.35) {
    verbatim = `${verbatim} ${pick(rng, PLAIN_TAILS)}`;
    rendered = verbatim;
  }

  return { verbatim, rendered, resolution };
}

/**
 * How a document refers to itself in its own body. Real documents say "this
 * agreement", not their own filename, and a corpus that quotes its own title
 * mid-sentence reads instantly wrong.
 */
export function selfReference(kind: BoundaryKind): string {
  switch (kind) {
    case 'contract': return 'this agreement';
    case 'paper': return 'this paper';
    case 'thread': return 'this thread';
    case 'pr': return 'this pull request';
    case 'chapter': return 'this chapter';
    case 'session': default: return 'this record';
  }
}

/**
 * A relation between DOCUMENTS (or a document and a person). Never takes a
 * connective, because its subject is often a self-reference that has to start
 * the sentence.
 */
export function documentClaim(
  rng: Rng,
  family: RelationFamily,
  subject: string,
  object: string,
  familyLabel: string,
): string {
  const variants = FAMILY_TEMPLATES[family];
  const template =
    variants && variants.length > 0
      ? pick(rng, variants)
      : pick(rng, ANNEX_FRAMES).replace('{f}', familyLabel);
  const body = template.replace('{s}', subject).replace('{o}', object);
  return body.charAt(0).toUpperCase() + body.slice(1);
}

/** One-line characterisation of a continent or island, reused at lod-1. */
export function regionSummary(base: string, assetCount: number, bridgeCount: number): string {
  return `${base} ${assetCount} assets on the spine, ${bridgeCount} entities shared with other islands.`;
}
