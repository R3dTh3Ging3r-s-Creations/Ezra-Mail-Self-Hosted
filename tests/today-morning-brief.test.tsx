import { render,screen,fireEvent,within } from '@testing-library/react';
import { it,expect,vi } from 'vitest';
import { TodayMorningBrief } from '@/components/ezra/TodayMorningBrief';
import { deterministicBrief } from '@/lib/email/morning-brief-copy';
import { compareBriefEvidence } from '@/lib/email/morning-brief-changes';
import type { MorningBriefView } from '@/lib/email/morning-brief-types';
import { evidence,fact,NOW } from './fixtures/morning-brief';
function morning():MorningBriefView{return {day:'2026-09-21',timezone:'America/Chicago',status:'available',scheduledLocalTime:'08:30',preparedAt:NOW,checkedAt:NOW,narrative:deterministicBrief(evidence()),changes:[],changeNarrative:null,sources:[{sourceKey:fact().sourceKey,target:fact().target,currentState:'open',changed:false}],coverage:evidence().coverage,truncated:false};}
it('keeps morning wording visible after a later meeting change and uses exact source links',()=>{
 const value=morning(),onOpen=vi.fn();const view=render(<TodayMorningBrief value={value} onOpen={onOpen}/>);
 const calendar=fact({sourceKey:'calendar:gmail-1:meeting',sourceType:'calendar_event',role:'agenda',target:{view:'calendar',eventId:'event',date:'2026-09-21'},startsAt:NOW});
 const changes=compareBriefEvidence(evidence({facts:[calendar]}),evidence({facts:[{...calendar,startsAt:'2026-09-21T17:00:00Z'}]}));
 view.rerender(<TodayMorningBrief value={{...value,checkedAt:'2026-09-21T16:00:00Z',changes,sources:[...value.sources,{sourceKey:calendar.sourceKey,target:calendar.target,currentState:'open',changed:true}]}} onOpen={onOpen}/>);
 expect(screen.getByText(value.narrative!.overview.text)).toBeVisible();expect(screen.getByRole('heading',{name:'Since your brief'})).toBeVisible();
 expect(screen.getByText(/Prepared at 9:00 AM/)).toBeVisible();expect(screen.getByText(/Checked at 11:00 AM/)).toBeVisible();
 fireEvent.click(screen.getAllByRole('button',{name:/Open mail source/})[0]);expect(onOpen).toHaveBeenCalledWith({view:'mail',messageId:'message-1'});
 fireEvent.click(screen.getByRole('button',{name:/Open calendar source/}));expect(onOpen).toHaveBeenLastCalledWith(calendar.target);
 expect(screen.queryByRole('button',{name:/Mark handled|Complete/})).not.toBeInTheDocument();
});
it('shows current handled state beside a historical source',()=>{
 const value=morning();render(<TodayMorningBrief value={{...value,sources:value.sources.map(s=>({...s,currentState:'completed',changed:true}))}} onOpen={vi.fn()}/>);
 expect(screen.getAllByText('Handled').length).toBeGreaterThan(0);
});
it('limits the visible changes and retains expansion across refreshes',()=>{
 const value=morning();const changes=Array.from({length:5},(_,i)=>({id:String(i),kind:'new' as const,sourceKey:null,text:'Change '+i}));
 const view=render(<TodayMorningBrief value={{...value,changes}} onOpen={vi.fn()}/>);
 expect(screen.getByText('Change 3')).not.toBeVisible();fireEvent.click(screen.getByText('2 more changes'));expect(screen.getByText('Change 4')).toBeVisible();
 view.rerender(<TodayMorningBrief value={{...value,changes,checkedAt:'2026-09-21T16:00:00Z'}} onOpen={vi.fn()}/>);expect(screen.getByText('Change 4')).toBeVisible();
});
it.each(['scheduled','pending','unavailable'] as const)('explains the %s state without claiming nothing changed',status=>{
 render(<TodayMorningBrief value={{...morning(),status,narrative:null}} onOpen={vi.fn()}/>);
 expect(screen.queryByText(/No meaningful changes/)).not.toBeInTheDocument();
 expect(screen.getByRole('heading',{name:'Daily brief'})).toBeVisible();
});
it('discloses partial coverage and refuses old-day text',()=>{
 const value=morning();const view=render(<TodayMorningBrief value={{...value,status:'limited',truncated:true}} onOpen={vi.fn()}/>);
 expect(screen.queryByText(/No meaningful changes/)).not.toBeInTheDocument();expect(screen.getByText(/Coverage is limited/)).toBeVisible();
 view.rerender(<TodayMorningBrief value={{...value,checkedAt:'2026-09-22T14:00:00Z'}} onOpen={vi.fn()}/>);expect(screen.queryByText(value.narrative!.overview.text)).not.toBeInTheDocument();
});
