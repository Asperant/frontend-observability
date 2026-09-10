select * from _rumdata
where frontend_observability_correlation_epoch_id = :epoch_id
  and frontend_observability_correlation_session_id = :session_id
  and frontend_observability_correlation_view_id = :view_id
  and _timestamp between :window_start and :window_end
union all
select * from _rumlog
where frontend_observability_correlation_epoch_id = :epoch_id
  and frontend_observability_correlation_session_id = :session_id
  and frontend_observability_correlation_view_id = :view_id
  and _timestamp between :window_start and :window_end
order by _timestamp asc
limit 200;
