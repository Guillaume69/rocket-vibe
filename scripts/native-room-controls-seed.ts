// Disposable GTK fixture. Credentials and room names are synthetic.
import {NativeTransport} from '../apps/mobile/fournisseurs/rocketvibe/transport.ts';
const owner=new NativeTransport(process.env.RV_ROOM_PEER_URL!),member=new NativeTransport(process.env.RV_ROOM_PEER_URL!);
await owner.login('desktop','room-test-password-2026');const mobile=await member.login('mobile','room-test-password-2026');
const room=await owner.createRoom({operation_id:'controls-'+process.env.RV_ROOM_PHASE,name:process.env.RV_ROOM_NAME!,private:true});
await owner.addMember(room.id,mobile.user.id);
console.log(JSON.stringify({seeded:true,members:2}));
