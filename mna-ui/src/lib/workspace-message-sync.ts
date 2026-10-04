import {
  fromThreadMessageLike,
  type ThreadMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";

type Repository = {
  headId?: string | null;
  messages: { message: ThreadMessage; parentId: string | null }[];
};

/** Append an explicit workspace result to the branch the analyst is viewing.
 * The persisted chat branch may lag a BranchPicker selection. */
export function appendWorkspaceMessages(
  repository: Repository,
  drafts: ThreadMessageLike[],
): Repository {
  const messages = [...repository.messages];
  let headId = repository.headId ?? null;
  for (const draft of drafts) {
    if (!draft.id || messages.some((item) => item.message.id === draft.id))
      continue;
    const message = fromThreadMessageLike(draft, draft.id, {
      type: "complete",
      reason: "stop",
    });
    messages.push({ message, parentId: headId });
    headId = message.id;
  }
  return { ...repository, headId, messages };
}
