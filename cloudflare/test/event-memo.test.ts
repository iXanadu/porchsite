import {afterEach,expect,it,vi} from 'vitest';
import {eventMemo,eventView,BLOCK_STRINGS} from '../src/blocks';
const event={start:'2027-01-14T18:00',end:'2027-01-14T20:30',place:{name:'<Hall>',address:'Street',map_link:'https://example.com/map'},rsvp:{label:'RSVP',link:'https://example.com/rsvp',deadline:'2027-01-10'},schedule:[{time:'18:00',title:'Start',note:''},{time:'18:15',title:'One',note:''},{time:'19:15',title:'Two',note:''},{time:'20:15',title:'End',note:''}],status:'on'};
afterEach(()=>vi.restoreAllMocks());
it('perf7b_components: identical values use three format calls, one zone parts call and five clock parses per render',()=>{
 const now=new Date('2026-10-18T12:00:00Z'),expected=eventView(event,'America/Chicago',now);
 const getFormat=Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype,'format')!.get!,split=String.prototype.split;
 let formats=0,clocks=0;
 vi.spyOn(Intl.DateTimeFormat.prototype as {format:unknown},'format','get').mockImplementation(function(this:Intl.DateTimeFormat){const format=getFormat.call(this);return(date?:number|Date)=>{formats++;return format(date);};});
 const parts=vi.spyOn(Intl.DateTimeFormat.prototype,'formatToParts'),wall=vi.spyOn(Date.prototype,'toISOString');
 vi.spyOn(String.prototype,'split').mockImplementation(function(this:string,separator:any,limit?:number){if(separator===':'&&/^\d{2}:\d{2}$/.test(String(this)))clocks++;return split.call(this,separator,limit);});
 const memo=eventMemo();for(let i=0;i<504;i++)expect(eventView(event,'America/Chicago',now,undefined,memo)).toEqual(expected);
 expect(formats).toBe(3);expect(parts).toHaveBeenCalledTimes(1);expect(clocks).toBe(5);expect(wall).toHaveBeenCalledTimes(1);
 eventView(event,'America/Chicago',now,undefined,eventMemo());expect(formats).toBe(6);expect(parts).toHaveBeenCalledTimes(2);expect(clocks).toBe(10);expect(wall).toHaveBeenCalledTimes(2);
});
it('perf7b_keys: event date, timezone and exact reference timestamp preserve DST and past comparisons',()=>{
 const memo=eventMemo();
 for(const tz of ['UTC','America/Chicago','Europe/London','Asia/Kolkata'])for(const date of ['2026-03-07','2026-03-09','2026-10-24','2026-10-26'])for(const now of [new Date('2026-03-08T07:59:00Z'),new Date('2026-03-08T08:01:00Z'),new Date('2026-11-01T07:00:00Z')]){
  const ev={...event,start:date+'T18:00',end:date+'T20:30',rsvp:{...event.rsvp,deadline:date}};
  expect(eventView(ev,tz,now,undefined,memo)).toEqual(eventView(ev,tz,now));
 }
 const now=new Date('2027-01-14T19:00:00Z');expect(eventView(event,'UTC',now,undefined,memo).is_past).toBe(false);now.setTime(Date.parse('2027-01-14T21:00:00Z'));expect(eventView(event,'UTC',now,undefined,memo).is_past).toBe(true);
});
it('perf7b_fields: multi-day, no-end, labels and all schedule/detail fields remain eager and independent',()=>{
 const memo=eventMemo(),now=new Date('2026-10-18T12:00:00Z');
 for(const ev of [event,{...event,end:'2027-01-16T09:00',status:'changed'},{...event,end:'',status:'cancelled',schedule:[]},{...event,rsvp:undefined,place:undefined}])for(const words of [BLOCK_STRINGS,{...BLOCK_STRINGS,rsvp_by:'By then',changed:'New time',cancelled:'Off'}])expect(eventView(ev,'Europe/London',now,words,memo)).toEqual(eventView(ev,'Europe/London',now,words));
 const one=eventView(event,'UTC',now,undefined,memo),two=eventView(event,'UTC',now,undefined,memo);expect(one.schedule).not.toBe(two.schedule);expect(one.schedule[0]).not.toBe(two.schedule[0]);expect(one.place_name).toBe('<Hall>');
 expect(eventView(null,'Invalid/Zone',now,undefined,memo)).toEqual({has:false});expect(()=>eventView(event,'Invalid/Zone',now,undefined,memo)).toThrow(RangeError);
});
