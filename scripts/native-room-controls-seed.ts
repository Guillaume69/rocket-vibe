// Disposable GTK fixture. Credentials and room names are synthetic.
import {NativeTransport} from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
const owner=new NativeTransport(process.env.RV_ROOM_PEER_URL!),member=new NativeTransport(process.env.RV_ROOM_PEER_URL!);
await owner.login('desktop','room-test-password-2026');const mobile=await member.login('mobile','room-test-password-2026');
const room=await owner.createRoom({operation_id:'controls-'+process.env.RV_ROOM_PHASE,name:process.env.RV_ROOM_NAME!,private:true});
await owner.addMember(room.id,mobile.user.id);
if(process.env.RV_ROOM_PHASE?.startsWith('reads')) {
  await member.send(room.id,{operation_id:process.env.RV_ROOM_PHASE+'-first',text:'Read fixture first @desktop'});
  await member.send(room.id,{operation_id:process.env.RV_ROOM_PHASE+'-second',text:'Read fixture second'});
}
if(process.env.RV_ROOM_PHASE?.startsWith('render')) {
  await member.send(room.id,{operation_id:process.env.RV_ROOM_PHASE+'-first',text:'**Un seul client** _deux serveurs_ :rocket:\n\n> Une citation @desktop\n\n- [x] Rocket.Chat\n- [ ] RocketVibe\n\n`@desktop` reste du code'});
  await member.send(room.id,{operation_id:process.env.RV_ROOM_PHASE+'-second',text:'Bonjour @desktop [le projet](https://example.org)\n\n```rust\nlet texte = "<>&";\n```\n\n:smile:'});
}
console.log(JSON.stringify({seeded:true,members:2}));
