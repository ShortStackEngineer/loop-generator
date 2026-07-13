import { useState } from "react";
import { recordQuiz } from "../progress";

export interface QuizQuestion {
  q: string;
  options: string[];
  /** index into options */
  answer: number;
  explain: string;
}

/**
 * A sequential quiz: answer each question, get instant right/wrong feedback with
 * an explanation, see a final score. Scoring >= 70% marks the module complete.
 */
export function Quiz(props: { moduleId: string; title?: string; questions: QuizQuestion[] }) {
  const [current, setCurrent] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [correctCount, setCorrectCount] = useState(0);
  const [finished, setFinished] = useState(false);

  const total = props.questions.length;
  const question = props.questions[current];

  function pick(i: number) {
    if (picked !== null || !question) return;
    setPicked(i);
    if (i === question.answer) setCorrectCount((c) => c + 1);
  }

  function next() {
    if (current + 1 >= total) {
      const score = correctCount / total;
      recordQuiz(props.moduleId, score);
      setFinished(true);
    } else {
      setCurrent((c) => c + 1);
      setPicked(null);
    }
  }

  function retry() {
    setCurrent(0);
    setPicked(null);
    setCorrectCount(0);
    setFinished(false);
  }

  if (finished) {
    const score = correctCount / total;
    const pass = score >= 0.7;
    return (
      <div className="quiz">
        <div className="quiz-header">
          <span className="quiz-badge">Quiz</span>
          <strong>{props.title ?? "Check your understanding"}</strong>
        </div>
        <div className="quiz-score" style={{ color: pass ? "var(--green)" : "var(--amber)" }}>
          {correctCount} / {total} correct {pass ? "— module complete ✓" : "— 70% needed to complete the module"}
        </div>
        <button className="btn secondary" onClick={retry}>
          Retake quiz
        </button>
      </div>
    );
  }

  if (!question) return null;

  return (
    <div className="quiz">
      <div className="quiz-header">
        <span className="quiz-badge">Quiz</span>
        <strong>{props.title ?? "Check your understanding"}</strong>
        <span className="quiz-progress" style={{ marginLeft: "auto" }}>
          {current + 1} / {total}
        </span>
      </div>
      <div className="quiz-q">{question.q}</div>
      {question.options.map((opt, i) => {
        let cls = "quiz-opt";
        if (picked !== null) {
          if (i === question.answer) cls += " correct";
          else if (i === picked) cls += " wrong";
          else cls += " dim";
        }
        return (
          <button key={i} className={cls} disabled={picked !== null} onClick={() => pick(i)}>
            {opt}
          </button>
        );
      })}
      {picked !== null && (
        <div className="quiz-explain">
          <strong style={{ color: picked === question.answer ? "var(--green)" : "var(--red)" }}>
            {picked === question.answer ? "Correct. " : "Not quite. "}
          </strong>
          {question.explain}
          <div className="btn-row">
            <button className="btn" onClick={next}>
              {current + 1 >= total ? "See score" : "Next question"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
