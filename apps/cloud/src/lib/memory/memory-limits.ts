// Length limits on a record's `text` / `statement`, in one place.
// SOFT is what the extraction prompts ask the model to aim for. HARD is what the schema accepts; text
// past it is cut at a boundary by over-cap.ts (never dropped for length). Measured under v24 (20
// sessions, 218 records): 8.3% ran past 240, none past 300; under a prompt without a drop threat the
// model drifted long, so the prompt still says overlong text is cut.
export const MEMORY_TEXT_SOFT = 300;
export const MEMORY_TEXT_MAX_HARD = 500;
