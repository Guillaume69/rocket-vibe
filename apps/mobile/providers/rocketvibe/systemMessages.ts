/** Adapt native activity to the system rows already used by the application. */
import type { CallSummary, SystemMessage } from './protocol.generated.ts';

/**
 * A direct call's row becomes `rv-call-<state>`, its parameter the duration in
 * seconds when known. A row without outcome (a retired Jitsi meeting) is a
 * plain `rv-call`: no join, nothing left to join.
 */
export function nativeSystemMessage(activity: SystemMessage, call?: CallSummary|null): {type:string;param:string} {
  switch(activity.kind) {
    case 'call_started':return {type:call?`rv-call-${call.state}`:'rv-call',param:call?.duration_seconds==null?'':String(call.duration_seconds)};
    case 'room_created':return {type:'rv-room-created',param:activity.name};
    case 'room_renamed':return {type:'r',param:activity.name};
    case 'topic_changed':return {type:'room_changed_topic',param:activity.topic};
    case 'description_changed':return {type:'room_changed_description',param:activity.description};
    case 'announcement_changed':return {type:'room_changed_announcement',param:activity.announcement};
    case 'privacy_changed':return {type:activity.private?'rv-room-private':'rv-room-public',param:''};
    case 'read_only_changed':return {type:activity.read_only?'room-set-read-only':'room-removed-read-only',param:''};
    case 'member_joined':return {type:'uj',param:''};
    case 'member_left':return {type:'ul',param:''};
    case 'member_added':return {type:'au',param:activity.user.username};
    case 'member_removed':return {type:'ru',param:activity.user.username};
    case 'role_changed':return {type:`rv-role-${activity.role}`,param:activity.user.username};
  }
}
