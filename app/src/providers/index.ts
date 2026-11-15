import { bsport } from "./bsport";
import type { Provider } from "./types";

/** Add studios here. Any bSport studio just needs its company id (visible in its booking URL). */
const all: Provider[] = [
  bsport({
    id: "pace-club",
    name: "Pace Club",
    location: "London Bridge",
    companyId: 4961,
    timezone: "Europe/London",
  }),
];

export const providers = new Map(all.map((p) => [p.id, p]));
