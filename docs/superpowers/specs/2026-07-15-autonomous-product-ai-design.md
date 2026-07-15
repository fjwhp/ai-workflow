# Autonomous Product AI Design

## Goal

Upgrade the Product PRD AI from a generic structured-output agent into a high-autonomy product role that investigates available context, makes reversible product decisions, and asks humans only about genuinely blocking, high-impact ambiguity.

## Research Inputs

The design adapts methods from publicly inspectable product-management skills without installing or copying them into the application:

- `deanpeters/Product-Manager-Skills`: separate the literal ask from the underlying job-to-be-done, infer without inventing, and label assumptions.
- `Mehdibargach/claude-code-pm-skills`: produce concise engineering-ready PRDs with explicit decisions, metrics, MVP scope, and exclusions.
- `springhalu0319/prd-writer-skill`: proactively detect missing workflow steps and review the result from product, user, engineering, and test perspectives.

## Product Decision Policy

Every unknown is classified before the AI decides whether to continue:

### Evidence Gap

The answer may already exist in the linked repository, prior requirement revisions, approved artifacts, or approval history. The AI searches the allowed context before asking a person.

### Reversible Assumption

The decision is inexpensive to change and does not create material business, security, compliance, financial, privacy, or compatibility risk. The AI selects a conventional default, records the assumption and rationale, and continues.

Examples include empty-state copy behavior, ordinary pagination defaults, common validation messages, and whether a non-critical optional field is initially hidden.

### Blocking Decision

The alternatives materially change permissions, money movement, legal or regulatory behavior, private-data handling, destructive data operations, irreversible compatibility, or mutually exclusive core business rules. The AI does not guess. It records a structured blocking question with impact and options, and routes the stage to human review.

The default is progress. Lack of information alone is not a reason to block.

## Read-Only Project Investigation

When the requirement is linked to a project, the Product AI receives a bounded, read-only repository context before the model call.

The collector may inspect:

- Root and module README files.
- Build manifests and module structure.
- API contracts, route/controller signatures, request and response types.
- Database migrations and schema declarations.
- Relevant domain models, services, tests, and existing validation rules.
- Existing project documentation and non-sensitive configuration examples.

The collector must not read `.env` files, credentials, keys, certificates, Git internals, build outputs, dependency directories, or paths matched by the project's sensitive patterns. It never executes project code and never modifies the repository.

Collection is bounded by file count, per-file size, total character count, and relevance to requirement terms. Every included excerpt records its relative path so the PRD can cite evidence.

## Product Role Skill

The application owns a versioned product-role policy rather than importing an external runtime Skill. Prompt construction includes:

1. Decode the literal request and infer the business outcome.
2. Identify users, trigger, current workaround, pain, and measurable success.
3. Search supplied project evidence before declaring a gap.
4. Make and label reversible assumptions.
5. Define MVP, non-goals, primary flow, exception flows, compatibility, and observable acceptance criteria.
6. Self-review from product, user, engineering, and test perspectives.
7. Emit blocking questions only under the Product Decision Policy.

The prompt explicitly prohibits asking a human to choose ordinary implementation details that the AI can safely decide.

## Structured Output

The Product PRD artifact retains the existing common fields and adds:

- `underlyingGoal`: the outcome behind the literal request.
- `targetUsers`: specific users and triggering situations.
- `productDecisions`: autonomous decisions with rationale and evidence.
- `assumptions`: reversible assumptions, validation method, and impact if wrong.
- `scope`: MVP and explicit non-goals.
- `flows`: primary and exception flows.
- `acceptanceCriteria`: observable, testable outcomes.
- `evidence`: repository or workflow references used by the AI.
- `blockingQuestions`: high-risk questions containing impact and concrete options.

`openQuestions` may remain for compatibility, but non-blocking questions do not trigger human review. Only `blockingQuestions` affect the PRD gate.

## Gate Behavior

For the PRD stage:

- No blocking questions and adequate confidence: continue through the configured automatic gate.
- One or more blocking questions: human review is required.
- Missing repository evidence with safe reversible defaults: continue with labeled assumptions.
- Model failure, invalid structured output, or inability to enforce sensitive-path exclusions: fail safely and do not invent a PRD.

Other workflow stages retain their current gate behavior.

## User Interface

The PRD artifact view adds compact, directly inspectable sections:

- `AI 自主补全`: decisions made without human input.
- `依据`: workflow facts and repository paths used.
- `采用的假设`: reversible defaults and how to validate them.
- `需要人工决定`: blocking questions only, with impact and alternatives.

The human reviewer evaluates the completed PRD rather than responding to a long questionnaire. If no blocking questions exist, the UI does not suggest that clarification is required.

## Observability

Stage-run events record repository context collection without exposing excluded content:

- Search terms and relevant path count.
- Included relative paths and truncation status.
- Product-policy version.
- Counts of autonomous decisions, assumptions, and blocking questions.

The existing run details continue to show sanitized model input and final output.

## Testing

- Unit tests classify evidence gaps, reversible assumptions, and blocking decisions.
- Repository-context tests prove relevant files are included and sensitive files are excluded.
- Prompt tests prove the Product AI is instructed to decide ordinary details and reserve escalation for high-risk ambiguity.
- Gate tests prove ordinary `openQuestions` do not block PRD progression while `blockingQuestions` do.
- API tests prove PRD runs include project evidence without modifying the repository.
- View tests prove autonomous decisions, evidence, assumptions, and blocking questions are distinguishable.
- Full tests, typecheck, production build, and a read-only Soto Dine browser trial are required.

## Non-Goals

- Installing third-party skills into the application runtime.
- Letting the Product AI browse the public internet during each PRD run.
- Allowing the Product AI to modify source code.
- Removing human review for genuinely high-risk product decisions.
- Changing engineering, coding, review, testing, or acceptance role policies in this iteration.
