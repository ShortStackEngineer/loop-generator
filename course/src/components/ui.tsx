import type { ReactNode } from "react";

export function Callout(props: {
  kind?: "info" | "warn" | "danger" | "success";
  title: string;
  children: ReactNode;
}) {
  const kind = props.kind ?? "info";
  return (
    <div className={`callout ${kind === "info" ? "" : kind}`}>
      <div className="callout-title">{props.title}</div>
      {props.children}
    </div>
  );
}

export function Code(props: { children: string; file?: string }) {
  return (
    <div>
      {props.file && <span className="filename-chip">{props.file}</span>}
      <pre className="codeblock">{props.children}</pre>
    </div>
  );
}

export function Card(props: { children: ReactNode }) {
  return <div className="card">{props.children}</div>;
}

export function Section(props: { title: string; children: ReactNode }) {
  return (
    <div className="section">
      <h2>{props.title}</h2>
      {props.children}
    </div>
  );
}
