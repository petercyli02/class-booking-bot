/** A class session, normalised across booking platforms. */
export interface FitnessClass {
  /** Globally unique: "<providerId>:<externalId>" */
  key: string;
  providerId: string;
  externalId: string;
  name: string;
  /** ISO 8601, UTC */
  start: string;
  durationMin: number;
  capacity: number;
  booked: number;
  spots: number;
  full: boolean;
  /** Not yet open for booking (outside the booking window) */
  bookable: boolean;
  /** When booking opens, if not yet open (ISO) */
  opensAt: string | null;
  bookUrl: string;
}

/**
 * A studio you can watch. To support a new studio on an existing platform, add a
 * config entry in providers/index.ts. To support a new platform (Mindbody, Glofox,
 * TeamUp...), write an adapter that returns this shape.
 */
export interface Provider {
  id: string;
  name: string;
  location: string;
  timezone: string;
  /** Classes whose start date (local) is within [from, to], both "YYYY-MM-DD". */
  listClasses(from: string, to: string): Promise<FitnessClass[]>;
}
