-- Office 只读 PDF 预览绑定（#431；ADR-0021 §2「预览绑定」）。
-- 预览是派生阅读副本：与原件的 sha256 绑定，权限继承原件；转换失败只影响预览，
-- 不阻止原件交付。一件原件至多一条预览记录（重转换覆盖同一条）。

create type artifact_preview_status as enum ('ready', 'failed');

create table artifact_preview (
  artifact_id uuid primary key references artifact(id),
  status artifact_preview_status not null,
  -- 生成预览时的原件摘要；必须等于 artifact.sha256（不可变版本绑定）。
  source_sha256 char(64) not null,
  converter varchar(100) not null,
  -- ready 时：内容寻址 blob 与实收 PDF 元数据。failed 时全为 NULL。
  storage_key text,
  sha256 char(64),
  byte_size bigint,
  media_type varchar(200),
  failure_reason varchar(2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint artifact_preview_source_digest check (source_sha256 ~ '^[a-f0-9]{64}$'),
  constraint artifact_preview_converter_length check (length(btrim(converter)) between 1 and 100),
  constraint artifact_preview_ready_fields check (
    (
      status = 'ready'
      and storage_key is not null
      and sha256 is not null
      and byte_size is not null
      and byte_size between 1 and 52428800
      and media_type = 'application/pdf'
      and failure_reason is null
    )
    or (
      status = 'failed'
      and storage_key is null
      and sha256 is null
      and byte_size is null
      and media_type is null
      and failure_reason is not null
    )
  ),
  constraint artifact_preview_failure_reason_length check (
    failure_reason is null or length(btrim(failure_reason)) between 1 and 2000
  )
);

create index artifact_preview_by_status
  on artifact_preview (status, updated_at);
