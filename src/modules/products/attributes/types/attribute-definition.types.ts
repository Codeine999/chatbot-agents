import type { AttributeDefinitionInput } from '../dto/attribute-definition.dto';

export const ATTRIBUTE_SCOPES = ['PRODUCT', 'VARIANT', 'SLOT'] as const;
export const ATTRIBUTE_TYPES = [
  'TEXT',
  'NUMBER',
  'BOOLEAN',
  'SELECT',
  'MULTI_SELECT',
  'TAGS',
] as const;
export type AttributeScope = (typeof ATTRIBUTE_SCOPES)[number];
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

/** The subset of a stored definition that validation, search and answers need. */
export type AttributeDefinition = Readonly<{
  key: string;
  label: string;
  scope: AttributeScope;
  type: AttributeType;
  options: readonly string[];
  valueAliases: Readonly<Record<string, readonly string[]>>;
  unit: string | null;
  required: boolean;
  variantOption: boolean;
  searchable: boolean;
  aiVisible: boolean;
  categories: readonly string[];
  sortOrder: number;
  status: 'ACTIVE' | 'ARCHIVED';
}>;

/** Business wording added to the product planner and answer prompts. */
export type BusinessPrompt = Readonly<{
  planner: string;
  answer: string;
  /** Extra answer rules inserted before the shared candidate (matchedBy) rule. */
  answerTail?: string;
}>;

/** How a customer can be told "is it still available": one state per row/slot. */
export type AvailabilityState =
  | 'AVAILABLE'
  | 'LOW'
  | 'FULL'
  | 'CLOSED'
  | 'UNKNOWN'
  | 'NOT_TRACKED';

/** What a business sells against and how its availability is read. */
export type BusinessCapabilities = Readonly<{
  /** Source of "is it still available": stock per variant, capacity per slot, or nothing. */
  inventory: 'VARIANT_STOCK' | 'SLOT_CAPACITY' | 'NONE';
  /** Show the real number ("5 seats left") or only the state. */
  showQuantity: boolean;
  /** Left <= this value is LOW. */
  lowThreshold: number | null;
  /** Largest quantity (people/pieces) a customer can ask about at once. */
  maxQuantity: number;
  slot?: Readonly<{
    /** How many days ahead customers may ask. */
    horizonDays: number;
    /** Within this many minutes before it starts a slot counts as CLOSED. */
    cutoffMinutes: number;
    /** Availability confirmed longer ago than this is UNKNOWN; null = never stale. */
    maxAgeMinutes: number | null;
    /** "Next one" looks this many hours ahead (default 24: next departure; an intake needs months). */
    nextWithinHours?: number;
  }>;
}>;

/**
 * Customer wording of one business. Signal lists are matched according to
 * `matchMode`: SUBSTRING compiles the entries as one case-insensitive regular
 * expression (entries are regex source fragments, exactly the former hardcoded
 * ECOMMERCE patterns); WORD matches whole Thai words after Intl.Segmenter word
 * segmentation, so a short signal such as "สี" cannot match inside "เสีย".
 */
export type BusinessLexicon = Readonly<{
  matchMode: 'SUBSTRING' | 'WORD';
  /** What the store calls one thing it sells ("สินค้า", "เส้นทาง", "หลักสูตร"). */
  itemNoun: string;
  /** Unit of the customer's quantity ("ชิ้น", "ที่นั่ง", "ที่"). */
  unit: string;
  availability: Readonly<Record<AvailabilityState, string>>;
  clarify: Readonly<{
    /** Several candidates; `{choices}` is replaced by the names joined with " / ". */
    which: string;
    /** Nothing to look up yet. */
    none: string;
    /** No catalog data could be read. */
    unavailable: string;
    /** Nothing matched. */
    notFound: string;
    /** Candidates rejected as not what was asked. */
    unmatched: string;
    /** Appended to `unmatched` when near candidates exist; `{names}` is replaced. */
    unmatchedNear: string;
    /** Date/time of a dated slot is missing. */
    when?: string;
    /** The requested date is outside the answerable window; `{date}`, `{days}`. */
    outOfWindow?: string;
    /** No slot in the requested window; `{name}`, `{when}`. */
    noSlot?: string;
  }>;
  /** Wording of the timetable answer (businesses that sell dated slots). */
  schedule?: Readonly<{
    /** First line of a timetable; `{name}`. */
    title: string;
    /** First line when only the next slot was asked; `{name}`. */
    nextTitle: string;
    /** Added to the first line when a party size was asked; `{quantity}`. */
    forQuantity: string;
    /** Line before the nearby slots that can still be taken. */
    alternatives: string;
    /** A long timetable that was cut: `{count}`, `{first}`, `{last}`. */
    summary: string;
    /** Seats left on a line: `{left}`, `{unit}`. */
    left: string;
    /** Some seats remain but fewer than the party needs: `{left}`, `{unit}`, `{quantity}`. */
    notEnough?: string;
    /** Arrival on a line: `{arrive}`. */
    arrive: string;
    /**
     * One-day departure timetable (the layout of a bus company's timetable):
     * title with `{origin}`, `{destination}`; left out, the usual timetable is used.
     */
    mainTitle?: string;
    /** One departure place with its times: `{place}`, `{times}`. */
    departure?: string;
    /** Price of the listed rounds when they differ: `{min}`, `{max}`. */
    priceRange?: string;
    /** Price of the listed rounds when they are all the same: `{price}`. */
    priceFixed?: string;
    /** Closing line: rounds may change, check before travelling. */
    notice?: string;
  }>;
  /**
   * Notes written after a price range (docs/multiPriceTransport.md); left out,
   * the core's neutral wording applies.
   */
  price?: Readonly<{
    /** One price that is not final yet ("316.00–416.00 บาท (ราคาโดยประมาณ)"). */
    estimate: string;
    /** Rounds of one item cost different amounts. */
    bySlot: string;
    /** They differ and at least one is an estimate. */
    bySlotEstimate: string;
    /** Prose that would call an estimated price final ("แน่นอน"). */
    certainWords: readonly string[];
  }>;
  /** Words that say the question is about the catalog -> PLAN. */
  signals: readonly string[];
  /** Words that say the question is about store policy. */
  policySignals: readonly string[];
  /** Words that refer back to something already shown. */
  referenceSignals: readonly string[];
  askSignals: Readonly<{ PRICE: readonly string[]; STOCK: readonly string[] }>;
  /** Whole-message regex sources (whitespace removed first): a catalog opener. */
  broadInquiry: readonly string[];
  /** Whole-message regex sources: policy questions that keep the legacy route. */
  standalonePolicyQuestions: readonly string[];
  /** Words that must not state a status in prose outside a token (regex fragments in SUBSTRING mode). */
  claimWords: readonly string[];
  /**
   * When set, a prose sentence that is a question (contains one of these words)
   * may use claim words ("ที่ว่างไหมคะ"); only declarative sentences are refused.
   */
  claimQuestionMarkers?: readonly string[];
  /** Question/classifier words that are never part of an item name for this business. */
  questionWords: readonly string[];
  /**
   * Words that come right before the name of one item ("รุ่น A", "หลักสูตร X",
   * "เส้นทาง กรุงเทพ"). Used to find which item a follow-up such as "อันนี้" means.
   */
  entityMarkers: readonly string[];
}>;

/** A selectable business: its meta fields, its prompt wording, capabilities and lexicon. */
export type BusinessPreset = Readonly<{
  label: string;
  prompt: BusinessPrompt;
  fields: readonly AttributeDefinitionInput[];
  /** Default = ECOMMERCE_CAPABILITIES. */
  capabilities?: BusinessCapabilities;
  /** Default = ECOMMERCE_LEXICON. */
  lexicon?: BusinessLexicon;
}>;
