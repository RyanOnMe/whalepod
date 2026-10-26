import { sql } from 'drizzle-orm'
import type { DbHandle } from '@whalepod/db'
import {
  ATTENTION_LIMIT,
  AttentionViewSchema,
  type AttentionItem,
  type AttentionView,
} from '@whalepod/protocol'
import type { SessionActor } from '../auth/session.js'

type Row = Omit<AttentionItem, 'createdAt'> & { createdAt: Date | string; priority: number }

/** One PostgreSQL statement: membership/ownership predicates precede sorting and limit.
 * No persisted reminders, private counts, tool arguments, or new authority. Commands
 * reached from these identities still re-check their original guards. */
export async function personalAttention(
  handle: DbHandle,
  actor: SessionActor,
): Promise<AttentionView> {
  const canReassign = actor.role === 'owner' || actor.role === 'admin'
  const rows = await handle.execute<Row>(sql`
    with eligible as (
      select t.*, p.name as project_name from task t join project p on p.id=t.project_id
      where t.status not in ('done','cancelled')
    ), actions as (
      select 'decide_approval' as kind, t.id as "taskId", t.title as "taskTitle", t.project_name as "projectName",
        a.id as "objectId", r.id as "runId", a.requested_at as "createdAt", 0 as priority
      from eligible t join run r on r.task_id=t.id join approval a on a.run_id=r.id
      where r.owner_user_id=${actor.userId} and t.assignee_user_id=${actor.userId}
        and t.assignment_status='accepted' and r.status='waiting_approval'
        and a.status='pending' and a.expires_at>now()
      union all
      select 'confirm_handoff',t.id,t.title,t.project_name,hr.id,null::uuid,hr.created_at,1
      from eligible t join handoff_receipt hr on hr.downstream_task_id=t.id
      where hr.receiver_user_id=${actor.userId} and hr.status='pending'
        -- 改派后旧回执不再属于当前责任人：不给旧接收人发一条确认了也无效的待办。
        and hr.receiver_user_id=t.assignee_user_id
      union all
      select 'submit_review',t.id,t.title,t.project_name,i.artifact_id,null::uuid,i.created_at,2
      from eligible t join artifact a on a.task_id=t.id
        join artifact_review_invitation i on i.artifact_id=a.id
      where i.reviewer_user_id=${actor.userId} and i.status='pending' and a.status='published'
      union all
      select 'organize_feedback',t.id,t.title,t.project_name,a.id,null::uuid,min(c.created_at),3
      from eligible t join artifact a on a.task_id=t.id and a.status='published'
        join artifact_comment c on c.artifact_id=a.id and c.parent_comment_id is null
        left join lateral (
          select rr.id,rr.created_at,rr.run_id,r.status as run_status,candidate.status as candidate_status
          from artifact_revision_round_comment rc
            join artifact_revision_round rr on rr.id=rc.round_id
            join run r on r.id=rr.run_id
            left join artifact_revision_link link on link.round_id=rr.id
            left join artifact candidate on candidate.id=link.candidate_artifact_id
          where rc.comment_id=c.id and rr.status='started'
          order by rr.created_at desc,rr.id desc limit 1
        ) latest on true
        left join artifact_comment_resolution resolution on resolution.round_id=latest.id and resolution.comment_id=c.id
      where t.assignee_user_id=${actor.userId} and t.assignment_status='accepted'
        and (latest.id is null or latest.run_status in ('failed','cancelled','lost')
          or latest.candidate_status='rejected' or resolution.status='needs_work'
          or exists (select 1 from artifact_comment reply where reply.parent_comment_id=c.id and reply.created_at>latest.created_at))
      group by t.id,t.title,t.project_name,a.id
      union all
      select 'resolve_comments',t.id,t.title,t.project_name,a.id,null::uuid,min(rr.started_at),3
      from eligible t join artifact a on a.task_id=t.id and a.status='published'
        join artifact_revision_round rr on rr.source_artifact_id=a.id and rr.status='started'
        join artifact_revision_link link on link.round_id=rr.id
        join artifact candidate on candidate.id=link.candidate_artifact_id and candidate.status='published'
        join artifact_revision_round_comment rc on rc.round_id=rr.id
        join artifact_comment c on c.id=rc.comment_id
      where c.author_user_id=${actor.userId}
        and not exists (select 1 from artifact_comment_resolution resolution where resolution.round_id=rr.id and resolution.comment_id=c.id)
      group by t.id,t.title,t.project_name,a.id
      union all
      select 'accept_assignment', t.id,t.title,t.project_name,t.id,null::uuid,t.updated_at,3
      from eligible t where t.assignee_user_id=${actor.userId} and t.assignee_agent_id is null and t.assignment_status='pending'
      union all
      select 'reassign_task',t.id,t.title,t.project_name,t.id,null::uuid,t.updated_at,4
      from eligible t where ${canReassign} and t.assignment_status='rejected'
        and not exists (select 1 from run r where r.task_id=t.id and r.status in ('queued','dispatching','running','waiting_approval','cancel_requested'))
      union all
      select 'inspect_candidate',t.id,t.title,t.project_name,a.id,a.run_id,a.created_at,5
      from eligible t join artifact a on a.task_id=t.id
      where a.status='candidate' and a.owner_user_id=${actor.userId}
      union all
      select 'complete_task',t.id,t.title,t.project_name,t.id,null::uuid,t.updated_at,6
      from eligible t where t.assignee_user_id=${actor.userId} and t.assignment_status='accepted' and t.status='in_review'
        and not exists (select 1 from run r where r.task_id=t.id and r.status in ('queued','dispatching','running','waiting_approval','cancel_requested'))
    )
    select * from actions order by priority,"createdAt",kind,"objectId" limit ${ATTENTION_LIMIT + 1}
  `)
  return AttentionViewSchema.parse({
    items: rows.slice(0, ATTENTION_LIMIT).map(({ priority: _priority, ...row }) => ({
      ...row,
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : new Date(row.createdAt).toISOString(),
    })),
    hasMore: rows.length > ATTENTION_LIMIT,
  })
}
