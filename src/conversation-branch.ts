import {
  selectConversationAncestors,
  type ConversationEntityId,
  type ConversationMessage,
} from "./conversation-domain";

export type ConversationMessageId = ConversationEntityId;
export type BranchConversationMessage = ConversationMessage;

/**
 * Builds the single ancestry path ending at `branchEndpointMessageId`.
 *
 * Conversation storage is append-only and can contain interleaved sibling
 * branches. Array position therefore cannot describe model context. User
 * questions point to their parent assistant answer, and assistant answers point
 * back to the question they answer. Following only those explicit links keeps
 * sibling branches out of the next model request.
 *
 * The endpoint must be the branch endpoint chosen for the next request, not a
 * message that the user merely scrolled to or is currently viewing.
 */
export function selectConversationBranch(
  messages: readonly BranchConversationMessage[],
  branchEndpointMessageId: ConversationMessageId | null | undefined,
): BranchConversationMessage[] {
  return selectConversationAncestors(messages, branchEndpointMessageId);
}
