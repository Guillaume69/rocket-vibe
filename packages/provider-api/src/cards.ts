/** Presentation shared by Rocket.Chat and Vibez attachments. */
export type IntegrationCard={author:string|null;title:string|null;url:string|null;pretext:string|null;text:string|null;color:string|null;fields:{title:string;value:string;short:boolean}[];actions:CardAction[]};
export type CardAction={id:string;name:string;style:string|null;cookie:string|null;menu:CardMenu|null};
/** A card menu: its listed choices, or people or channels the server searches, and the value chosen before any press. */
export type CardMenu={source:MenuSource;options:MenuOption[];initial:string|null};
export type MenuSource='options'|'users'|'channels';
export type MenuOption={label:string;value:string};
