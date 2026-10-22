// D4 + sub-agent prompt attribution.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PromptText } from "../prompt-text";

describe("PromptText", () => {
  it("hides HTML comments such as opencode's initiator marker", () => {
    const html = renderToStaticMarkup(<PromptText text="Audit the pipeline. <!-- OMO_INTERNAL_INITIATOR -->" />);
    expect(html).toContain("Audit the pipeline.");
    expect(html).not.toContain("OMO_INTERNAL_INITIATOR");
  });

  it("labels a sub-agent's prompt as coming from the parent agent", () => {
    expect(renderToStaticMarkup(<PromptText text="go" fromParentAgent />)).toContain("prompt from the parent agent");
    expect(renderToStaticMarkup(<PromptText text="go" />)).not.toContain("parent agent");
  });
});
