import type { QuoteReference, QuoteExcerpt } from "../protocol";
export type NativeQuoteAttachment = {
  message_link: string;
  native_reference: QuoteReference;
  native_unavailable: boolean;
  text: string;
  author_name?: string;
  attachments?: (NativeQuoteAttachment | Record<string, unknown>)[];
};
export type NativeQuoteSelection = {
  reference: QuoteReference;
  instance_id: string;
  data_epoch: string;
  membership_version: string;
  crypto_admission?: string;
};
export type PublicQuoteSources = {
  membership: string;
  messages: { id: string; excerpt: QuoteExcerpt }[];
};
