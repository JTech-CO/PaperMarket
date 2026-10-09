import {FinancialDecimal as D} from '../../domain/numeric.js';
import {z} from 'zod';
export const modelReturnRowSchema=z.strictObject({tick:z.number().int().min(1).max(100000),
  values:z.partialRecord(z.enum(['HGI','DNL','TLR','NXC','VTR','AUR','LMB','RVI']),z.number().finite().min(-1).max(1))});
export interface TickReturns {tick:number;values:Record<string,number>}
export interface ModelStatistics {returns:TickReturns[];limitHits:number;ordinaryPrices:number;liquidations:number;replacements:number;dividendCoverage:string[];pendingDeclarations:{id:string;issuerId:string;tick:number;atoms:string}[];initialValueGaps:Record<string,string>}
const finite=(v:number)=>{if(!Number.isFinite(v))throw new Error('MODEL_NONFINITE_STATISTIC');return v;};
export function correlation(pairs:readonly (readonly [number,number])[]):number|null {
  if(pairs.length<3)return null;let sx=0,sy=0;for(const [x,y] of pairs){sx+=x;sy+=y;}const mx=sx/pairs.length,my=sy/pairs.length;
  let xy=0,xx=0,yy=0;for(const [x,y] of pairs){xy+=(x-mx)*(y-my);xx+=(x-mx)**2;yy+=(y-my)**2;}
  return xx===0||yy===0?null:finite(Math.max(-1,Math.min(1,xy/Math.sqrt(xx*yy))));
}
export function distribution(samples:readonly number[]) {
  if(!samples.length)return {count:0,mean:null,q01:null,q05:null,median:null,q95:null,q99:null,expectedShortfall05:null};
  const sorted=[...samples].sort((a,b)=>a-b);const q=(p:number)=>finite(sorted[Math.floor((sorted.length-1)*p)]!);
  const tails=sorted.slice(0,Math.max(1,Math.ceil(sorted.length*0.05)));
  return {count:sorted.length,mean:finite(sorted.reduce((a,b)=>a+b,0)/sorted.length),q01:q(0.01),q05:q(0.05),median:q(0.5),q95:q(0.95),q99:q(0.99),expectedShortfall05:finite(tails.reduce((a,b)=>a+b,0)/tails.length)};
}
export function summarizeStatistics(stats:ModelStatistics) {
  const symbols=Object.keys(stats.initialValueGaps);const perCompany=Object.fromEntries(symbols.map(symbol=>{
    const samples=stats.returns.filter(r=>r.values[symbol]!==undefined);const pairs:Array<[number,number]>=[];
    for(let i=1;i<samples.length;i++)if(samples[i]!.tick===samples[i-1]!.tick+1)pairs.push([samples[i-1]!.values[symbol]!,samples[i]!.values[symbol]!]);
    return [symbol,{distribution:distribution(samples.map(r=>r.values[symbol]!)),lag1Autocorrelation:correlation(pairs),absoluteReturnClustering:correlation(pairs.map(([x,y])=>[Math.abs(x),Math.abs(y)]))}];
  }));
  const correlations:Record<string,number|null>={};for(let i=0;i<symbols.length;i++)for(let j=i+1;j<symbols.length;j++) {
    const a=symbols[i]!,b=symbols[j]!;correlations[`${a}/${b}`]=correlation(stats.returns.filter(r=>r.values[a]!==undefined&&r.values[b]!==undefined).map(r=>[r.values[a]!,r.values[b]!]));
  }
  return {perCompany,correlations,limitHits:stats.limitHits,ordinaryPrices:stats.ordinaryPrices,limitHitFrequency:stats.ordinaryPrices?stats.limitHits/stats.ordinaryPrices:null,
    liquidations:stats.liquidations,replacements:stats.replacements,dividendCoverage:distribution(stats.dividendCoverage.map(v=>finite(new D(v).toNumber()))),
    unpublishedDividendCoverage:stats.pendingDeclarations.length,initialValueGaps:stats.initialValueGaps,
    definition:'Adjusted committed returns; replacement discontinuities excluded. Correlation unavailable below 3 pairs or at zero variance. Ratios use Number only after financial Decimal normalization.'};
}
