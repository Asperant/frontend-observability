select * from _rumdata
where chicek_correlation_epoch_id = :epoch_id
  and chicek_correlation_session_id = :session_id
  and chicek_correlation_view_id = :view_id
union all
select * from _rumlog
where chicek_correlation_epoch_id = :epoch_id
  and chicek_correlation_session_id = :session_id
  and chicek_correlation_view_id = :view_id
order by _timestamp asc
limit 500;
