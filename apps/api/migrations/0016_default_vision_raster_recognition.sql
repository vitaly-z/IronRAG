alter table catalog_library
    alter column recognition_policy set default '{"rasterImageEngine": "vision"}'::jsonb;

update catalog_library
set recognition_policy = '{"rasterImageEngine": "vision"}'::jsonb,
    updated_at = now()
where recognition_policy = '{"rasterImageEngine": "docling"}'::jsonb;
