// G2 step 2.4h: the memory write barrel. `@/lib/memory/write` resolves here;
// the IO (formerly lib/memory/write.ts) lives in ./io, the pure sub-modules
// beside it. Import from the barrel, not from a sub-module path.
export * from "./blockers";
export * from "./feedback";
export * from "./insert";
export * from "./io";
export * from "./issues";
export * from "./lock";
export * from "./questionnaire";
export * from "./recurrence";
export * from "./retire";
export * from "./supersede";
