select * from _rumdata
where frontend_observability_correlation_epoch_id = :epoch_id
  and frontend_observability_correlation_session_id = :session_id
  and frontend_observability_correlation_view_id = :view_id
union all
select * from _rumlog
where frontend_observability_correlation_epoch_id = :epoch_id
  and frontend_observability_correlation_session_id = :session_id
  and frontend_observability_correlation_view_id = :view_id
order by _timestamp asc
limit 500;
