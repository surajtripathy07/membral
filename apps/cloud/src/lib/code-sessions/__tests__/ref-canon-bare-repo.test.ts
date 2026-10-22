// UX W6 review fix 3a: a bare repo NAME (no owner) is the session's own
// project repo only when it equals that repo's name; otherwise it is left
// alone (write time: not a ref; read time: its own group).
import { describe, expect, it } from "vitest";
import { canonicalItemRef, qualifyBareRepoRef } from "../ref-canon";

const PROJECT = "github.com/surajtripathy07/membral-personal";

describe("qualifyBareRepoRef", () => {
  it("qualifies a bare name equal to the project repo's name", () => {
    expect(qualifyBareRepoRef("membral-personal#118", PROJECT)).toBe(`${PROJECT}#118`);
    expect(qualifyBareRepoRef("Membral-Personal#119", PROJECT)).toBe(`${PROJECT}#119`);
  });

  it("leaves a bare name of some other repo, a qualified ref and a bare #N as written", () => {
    expect(qualifyBareRepoRef("billing#7", PROJECT)).toBe("billing#7");
    expect(qualifyBareRepoRef("acme/membral-personal#7", PROJECT)).toBe("acme/membral-personal#7");
    expect(qualifyBareRepoRef(`${PROJECT}#7`, PROJECT)).toBe(`${PROJECT}#7`);
    expect(qualifyBareRepoRef("#7", PROJECT)).toBe("#7");
  });

  it("does nothing without a project identity", () => {
    expect(qualifyBareRepoRef("membral-personal#118", null)).toBe("membral-personal#118");
    expect(qualifyBareRepoRef("membral-personal#118", undefined)).toBe("membral-personal#118");
  });
});

describe("canonicalItemRef on a bare repo name", () => {
  it("qualifies it to the project when the name matches", () => {
    expect(canonicalItemRef("membral-personal#118", PROJECT)?.ref).toBe(`${PROJECT}#118`);
  });

  it("is still not a ref when the name is some other repo, or there is no project", () => {
    expect(canonicalItemRef("billing#7", PROJECT)).toBeNull();
    expect(canonicalItemRef("membral-personal#118", null)).toBeNull();
    expect(canonicalItemRef("review-17049", PROJECT)).toBeNull();
  });
});
