"use client";

import { useState, type ComponentProps } from "react";
import { parseKeywordText, reconcileKeywordText } from "@/lib/admin/keyword-editor";

type Props = Omit<ComponentProps<"textarea">, "value" | "onChange"> & {
  values: string[];
  onValuesChange: (values: string[]) => void;
};

/** Raw text is local; parsed values reach the parent on every keystroke, not blur. */
export function KeywordListEditor({ values, onValuesChange, ...props }: Props) {
  const [text, setText] = useState(() => values.join("، "));
  const reconciled = reconcileKeywordText(text, values);
  if (reconciled !== text) setText(reconciled);
  return <textarea {...props} value={reconciled} onChange={event => {
    setText(event.target.value);
    onValuesChange(parseKeywordText(event.target.value));
  }} />;
}
