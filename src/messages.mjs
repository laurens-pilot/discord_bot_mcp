import * as z from "zod/v4";
import { nonblank } from "./schema.mjs";

export const pollInput = z.strictObject({
  question: nonblank(300),
  answers: z.array(nonblank(55)).min(2).max(10),
  duration_hours: z.number().int().min(1).max(768).default(24),
  allow_multiselect: z.boolean().default(false),
});

export function pollBody(poll) {
  return {
    question: { text: poll.question },
    answers: poll.answers.map((text) => ({ poll_media: { text } })),
    duration: poll.duration_hours,
    allow_multiselect: poll.allow_multiselect,
    layout_type: 1,
  };
}

export function pollSummary(poll) {
  return {
    question: poll.question?.text,
    answers: poll.answers.map((answer) => ({
      id: answer.answer_id,
      text: answer.poll_media?.text,
      ...(answer.poll_media?.emoji ? { emoji: answer.poll_media.emoji } : {}),
      ...(poll.results
        ? {
            votes:
              poll.results.answer_counts?.find(
                (count) => count.id === answer.answer_id,
              )?.count ?? 0,
          }
        : {}),
    })),
    expires_at: poll.expiry,
    allow_multiselect: poll.allow_multiselect,
    ...(poll.results ? { finalized: poll.results.is_finalized } : {}),
  };
}

export function messageSummary(message) {
  return {
    id: message.id,
    ...(message.author
      ? {
          author: {
            id: message.author.id,
            name: message.author.global_name || message.author.username,
          },
        }
      : {}),
    timestamp: message.timestamp,
    content: message.content,
    ...(message.message_snapshots?.length
      ? {
          forwarded: message.message_snapshots.map(({ message: snapshot }) =>
            messageSummary({ ...snapshot, message_snapshots: undefined }),
          ),
        }
      : {}),
    ...(message.channel_id ? { channel_id: message.channel_id } : {}),
    ...(message.edited_timestamp
      ? { edited_at: message.edited_timestamp }
      : {}),
    ...(message.pinned !== undefined ? { pinned: message.pinned } : {}),
    ...(message.poll ? { poll: pollSummary(message.poll) } : {}),
    ...(message.reactions?.length
      ? {
          reactions: message.reactions.map(
            ({ emoji, count, count_details }) => ({
              emoji,
              count,
              ...(count_details ? { counts: count_details } : {}),
            }),
          ),
        }
      : {}),
    ...(message.sticker_items?.length
      ? {
          stickers: message.sticker_items.map(({ id, name }) => ({ id, name })),
        }
      : {}),
    ...(message.type ? { type: message.type } : {}),
    ...(message.message_reference
      ? { reference: message.message_reference }
      : {}),
    ...(message.thread ? { thread_id: message.thread.id } : {}),
    ...(message.attachments?.length
      ? {
          attachments: message.attachments.map(
            ({ filename, url, content_type }) => ({
              filename,
              url,
              content_type,
            }),
          ),
        }
      : {}),
    ...(message.embeds?.length
      ? {
          embeds: message.embeds.map(
            ({ title, description, url, fields, image }) => ({
              title,
              description,
              url,
              fields,
              ...(image?.url ? { image_url: image.url } : {}),
            }),
          ),
        }
      : {}),
  };
}
