import {useMemo} from 'react';
import {PixelRatio,View} from 'react-native';
import {qrRuns,totpQr} from './totpQr.ts';

const MODULE=4;

export function TotpQrCode({uri,label}:{uri:string;label:string}) {
  const matrix=useMemo(()=>totpQr(uri),[uri]);
  const runs=useMemo(()=>matrix?qrRuns(matrix):[],[matrix]);
  if(!matrix)return null;
  const module=PixelRatio.roundToNearestPixel(MODULE),side=module*matrix.size;
  return <View accessible accessibilityRole="image" accessibilityLabel={label} style={{width:side,height:side,backgroundColor:'#ffffff',alignSelf:'center',borderRadius:6}}>
    {runs.map(run=><View key={`${run.y}:${run.x}`} style={{position:'absolute',left:run.x*module,top:run.y*module,width:run.length*module,height:module,backgroundColor:'#000000'}}/>)}
  </View>;
}
