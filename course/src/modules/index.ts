import type { ComponentType } from "react";
import { BigPicture } from "./01-big-picture";
import { SpecAnatomy } from "./02-spec-anatomy";
import { EngineMechanics } from "./03-engine-mechanics";
import { Prompting } from "./04-prompting";
import { TrustModel } from "./05-trust-model";
import { EvaluatorDesign } from "./06-evaluator-design";
import { Capstone } from "./07-capstone";

export interface CourseModule {
  id: string;
  title: string;
  subtitle: string;
  lede: string;
  Component: ComponentType;
  /** Companion reference doc on the main site (resolved relative to /course/). */
  docs?: { label: string; href: string };
}

export const MODULES: CourseModule[] = [
  {
    id: "big-picture",
    title: "The Big Picture",
    subtitle: "The loop, its four plug-in points, and why it exists",
    lede:
      "Before touching a single option, build the mental model: a spec describes a task and the tools that measure success; the engine drives an agent against those tools until they pass — or a guard says the green can't be trusted.",
    Component: BigPicture,
    docs: { label: "Getting started", href: "../docs/getting-started.html" },
  },
  {
    id: "spec-anatomy",
    title: "Anatomy of a .loop.yaml",
    subtitle: "Every field, every default, and what it controls",
    lede:
      "The spec is the whole contract. Explore a real spec field by field, learn the defaults the schema fills in, and see how success criteria compose.",
    Component: SpecAnatomy,
    docs: { label: "Authoring a loop", href: "../docs/authoring.html" },
  },
  {
    id: "engine-mechanics",
    title: "Inside the Engine Loop",
    subtitle: "Step through real runs: preflight → iterate → outcome",
    lede:
      "LoopEngine.run() is the whole control flow. Step through six scripted runs — including the failure modes — and watch every phase the engine executes.",
    Component: EngineMechanics,
    docs: { label: "Debugging a run", href: "../docs/debugging.html" },
  },
  {
    id: "prompting",
    title: "How the LLM Is Prompted",
    subtitle: "System prompt vs initial prompt vs iteration feedback",
    lede:
      "The agent sees three kinds of text: a constant system prompt, a rich initial prompt on iteration 0, and from then on — only feedback. Build them live and read exactly what the model reads.",
    Component: Prompting,
    docs: { label: "Authoring a loop", href: "../docs/authoring.html" },
  },
  {
    id: "trust-model",
    title: "The Trust Model",
    subtitle: "Why 'all checks passed' can lie, and the layered defenses",
    lede:
      "A green run is only meaningful if the checks exercise the requirement and the agent did real work. Play attacker against the engine's six defense layers and learn exactly where each one is (and isn't) watching.",
    Component: TrustModel,
    docs: { label: "Trust model", href: "../docs/trust.html" },
  },
  {
    id: "evaluator-design",
    title: "Designing Evaluators",
    subtitle: "Feedback tools that are falsifiable, actionable, and hard to fake",
    lede:
      "Evaluators are the loop's sensors — the run can only be as trustworthy as its measurements. Learn the command and experiment evaluators inside out, then judge real checks: RED-able or fake-able?",
    Component: EvaluatorDesign,
    docs: { label: "Authoring a loop", href: "../docs/authoring.html" },
  },
  {
    id: "capstone",
    title: "Capstone: Prove It",
    subtitle: "Predict outcomes of real runs, then the final exam",
    lede:
      "Expertise means predicting what the engine will do before it does it. Six run descriptions, six outcome predictions — then a final exam across everything.",
    Component: Capstone,
  },
];
