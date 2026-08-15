export type ComplexQuestionMode = "off" | "auto" | "always";

export interface ComplexQuestionPlan {
  shouldDecompose: boolean;
  rationale: string;
  subquestions: string[];
}

const MAX_SUBQUESTIONS = 3;

function normalizeQuestion(value: unknown) {
  return (typeof value === "string" || typeof value === "number"
    ? String(value)
    : ""
  )
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueQuestions(values: unknown[]) {
  const seen = new Set<string>();
  const questions: string[] = [];
  for (const value of values) {
    const question = normalizeQuestion(value).slice(0, 500);
    const key = question.toLocaleLowerCase();
    if (!question || seen.has(key)) {
      continue;
    }
    seen.add(key);
    questions.push(question);
    if (questions.length >= MAX_SUBQUESTIONS) {
      break;
    }
  }
  return questions;
}

export function questionLooksComplex(question: string) {
  const normalized = normalizeQuestion(question);
  if (normalized.length < 80) {
    return false;
  }
  const questionMarks = (normalized.match(/[?？]/g) || []).length;
  const enumeratedParts = (
    normalized.match(/(?:^|\s)(?:\d+[.)、]|[一二三四五六]+[、.])/g) || []
  ).length;
  const connectiveParts = (
    normalized.match(
      /另外|除此之外|同时|分别|以及|然后|最后|first|second|also|in addition|respectively/gi,
    ) || []
  ).length;
  return questionMarks >= 2 || enumeratedParts >= 2 || connectiveParts >= 2;
}

export function shouldPlanComplexQuestion(
  question: string,
  mode: ComplexQuestionMode,
) {
  return mode === "always" || (mode === "auto" && questionLooksComplex(question));
}

function extractJson(value: string) {
  const raw = String(value || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  return candidate.trim();
}

export function parseComplexQuestionPlan(value: string): ComplexQuestionPlan {
  try {
    const parsed = JSON.parse(extractJson(value));
    const subquestions = uniqueQuestions(
      Array.isArray(parsed?.subquestions) ? parsed.subquestions : [],
    );
    return {
      shouldDecompose:
        parsed?.should_decompose === true && subquestions.length >= 2,
      rationale: normalizeQuestion(parsed?.rationale).slice(0, 300),
      subquestions,
    };
  } catch {
    return { shouldDecompose: false, rationale: "invalid_plan", subquestions: [] };
  }
}

export function buildComplexQuestionPlanningMessages(question: string) {
  return [
    {
      role: "system",
      content: [
        "You plan a reading-assistance answer. Do not answer the question and do not use external tools.",
        "Split only when the question contains multiple independently investigable concerns. Prefer one direct answer for a single concept, even if it is difficult.",
        `Return JSON only: {"should_decompose":boolean,"rationale":string,"subquestions":[string]}. Use 2-${MAX_SUBQUESTIONS} concise, non-overlapping subquestions. Preserve the user's language.`,
      ].join(" "),
    },
    { role: "user", content: normalizeQuestion(question) },
  ];
}

export function buildSubquestionMessages(
  contextMessages: any[],
  originalQuestion: string,
  subquestion: string,
  index: number,
  total: number,
) {
  const stableContext = contextMessages.filter((message) => message?.role === "system");
  const imageParts = [...contextMessages]
    .reverse()
    .map((message) => message?.content)
    .find((content) => Array.isArray(content))
    ?.filter(
      (part) =>
        part &&
        typeof part === "object" &&
        (part.type === "image_url" || part.type === "input_image"),
    ) || [];
  const prompt = [
    `Original question: ${normalizeQuestion(originalQuestion)}`,
    "",
    `Subquestion ${index + 1} of ${total}: ${normalizeQuestion(subquestion)}`,
    "",
    "Answer only this subquestion. Keep the result compact, distinguish evidence from inference, and preserve usable citations. Other subquestions will be handled separately.",
  ].join("\n");
  return [
    ...stableContext,
    {
      role: "user",
      content: imageParts.length
        ? [{ type: "text", text: prompt }, ...imageParts]
        : prompt,
    },
  ];
}

export function buildComplexQuestionSynthesisMessages(
  systemPrompt: string,
  selectedPassage: string,
  originalQuestion: string,
  partialAnswers: Array<{ question: string; answer: string }>,
) {
  const partials = partialAnswers
    .map(
      (item, index) =>
        `## Part ${index + 1}: ${item.question}\n\n${item.answer}`,
    )
    .join("\n\n---\n\n");
  return [
    {
      role: "system",
      content: [
        systemPrompt,
        "You are now synthesizing partial analyses. No tools are available in this stage. Answer the original question directly, remove repetition, keep source links attached to supported claims, and disclose gaps instead of inventing evidence.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
    ...(selectedPassage
      ? [
          {
            role: "system",
            content: `Primary selected passage:\n\n${selectedPassage}`,
          },
        ]
      : []),
    {
      role: "user",
      content: [
        `Original question: ${normalizeQuestion(originalQuestion)}`,
        "",
        "Partial analyses:",
        partials,
      ].join("\n"),
    },
  ];
}
