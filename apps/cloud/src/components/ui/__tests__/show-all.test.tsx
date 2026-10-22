// UX audit B0: ShowAll never cuts a list silently — the hidden count always
// shows, and a caller can override the button label.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ShowAll } from "../show-all";

describe("ShowAll", () => {
  const items = Array.from({ length: 30 }, (_, i) => `item-${i}`);

  it("renders only the initial slice, plus the hidden count", () => {
    const html = renderToStaticMarkup(
      <ShowAll items={items} initial={5} renderItem={(item) => <p key={item}>{item}</p>} />,
    );
    expect(html).toContain("item-0");
    expect(html).toContain("item-4");
    expect(html).not.toContain("item-5");
    expect(html).toContain("+25 more");
  });

  it("accepts a custom label", () => {
    const html = renderToStaticMarkup(
      <ShowAll
        items={items}
        initial={5}
        label={(n) => `+${n} more acted on yesterday`}
        renderItem={(item) => <p key={item}>{item}</p>}
      />,
    );
    expect(html).toContain("+25 more acted on yesterday");
  });

  it("renders nothing extra when every item already fits", () => {
    const short = items.slice(0, 3);
    const html = renderToStaticMarkup(
      <ShowAll items={short} initial={5} renderItem={(item) => <p key={item}>{item}</p>} />,
    );
    expect(html).not.toContain("more");
  });
});
