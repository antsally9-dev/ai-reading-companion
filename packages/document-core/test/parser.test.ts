import assert from "node:assert/strict";
import test from "node:test";
import { parseMarkdown } from "../src/index.ts";

test("parses study-oriented Markdown blocks with stable line anchors", () => {
  const parsed = parseMarkdown(`# Agent memory\n\nMemory has three layers.\n\n- working\n- episodic\n\n| Kind | Scope |\n| --- | --- |\n| working | turn |\n\n\`\`\`ts\nconst memory = []\n\`\`\`\n`);
  assert.equal(parsed.title, "Agent memory");
  assert.deepEqual(parsed.blocks.map((block) => block.type), ["heading", "paragraph", "list", "table", "code"]);
  assert.deepEqual(parsed.blocks[1] && [parsed.blocks[1].startLine, parsed.blocks[1].endLine], [3, 3]);
  assert.equal(new Set(parsed.blocks.map((block) => block.id)).size, parsed.blocks.length);
});

test("recognises images without loading them", () => {
  const parsed = parseMarkdown("![Agent loop](images/loop.png)");
  assert.equal(parsed.blocks[0]?.type, "image");
  assert.equal(parsed.blocks[0]?.imageSource, "images/loop.png");
});
