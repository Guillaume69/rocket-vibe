import type { Message, FileDescriptor, User, PreviewImage } from "./protocol";
export { safeLink } from "./ui/links";
export { markdown, messageRow } from "./ui/messages";
export interface RowActions {
  privateFiles?: boolean;
  updateMessage?(
    message: Message,
    revision: string,
    text: string,
    id: string,
  ): Promise<void>;
  profile(message: Message): Promise<void>;
  menu(message: Message, anchor: HTMLElement): Promise<void>;
  answerForm(message: Message): Promise<void>;
  thread(message: Message): Promise<void>;
  reaction(message: Message, emoji: string): Promise<void>;
  file(file: FileDescriptor, node: HTMLElement): Promise<void>;
  avatar(user: User, node: HTMLElement): void;
  emoji(code: string, node: HTMLElement): void;
  mention(name: string, node: HTMLElement): void;
  previewImage(
    message: Message,
    image: PreviewImage,
    node: HTMLElement,
  ): Promise<void>;
}
