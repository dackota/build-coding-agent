// The todo list: the model's plan, kept in the session state so a cold wake still has it.
// todo_write replaces the whole list; the executor saves it with the session after each step.
import { tool } from "ai";
import { z } from "zod";
import type { Todo } from "./session-state.ts";

export const TODO_TOOL = "todo_write";

/** The list a turn works on; the tool replaces `list`, the executor saves it. */
export type TodoHolder = { list: Todo[] };

/** One line per todo, "N. [status] content". */
export const formatTodos = (todos: readonly Todo[]): string => todos.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join("\n");

export function createTodoTool(holder: TodoHolder) {
  return tool({
    description: `Write your todo list: the steps of the task and the state of each. Replaces the whole list. Returns the list as saved.

WHEN TO USE: a task with three or more steps; at the start to plan, and again whenever a step starts or finishes.

WHEN NOT TO USE: a one-step task or a plain question.

DO NOT USE FOR: notes or findings; keep those in your answer.

USAGE: send every item each time, not only the changed ones. Keep at most one item in_progress. Mark an item completed only when its check passed.

EXAMPLES:
  - todos [{"content":"find where the port is set","status":"in_progress"},{"content":"change it and run the tests","status":"pending"}]`,
    inputSchema: z.object({
      todos: z.array(z.object({ content: z.string().min(1), status: z.enum(["pending", "in_progress", "completed"]) })),
    }),
    execute: async ({ todos }) => {
      holder.list = todos;
      return todos.length === 0 ? "todo list is empty" : `todo list saved:\n${formatTodos(todos)}`;
    },
  });
}
